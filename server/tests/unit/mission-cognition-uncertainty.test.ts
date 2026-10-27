/**
 * Phase 5 uncertainty engine tests — CONTRACT-phase5.md criteria 1-24
 * (deployment acceptance §4.25 is exercised post-image-rebuild).
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { evaluateTriggers } from '../../src/services/mission-cognition/uncertainty-triggers.js';
import { traceAssumptionDependencies } from '../../src/services/mission-cognition/dependency-traversal.js';
import { buildBlindBrief, createBlindWorkItem, assertBlindPayloadClean } from '../../src/services/mission-cognition/blind-work.js';
import { measureHypothesisDiversity, assessHypothesisAcceptance } from '../../src/services/mission-cognition/hypothesis-diversity.js';
import { invalidateDecision } from '../../src/services/mission-cognition/invalidation.js';
import { proposeExperiment, listExperiments, resolveExperiment } from '../../src/services/mission-cognition/experiment-registry.js';
import { recordTriggerOutcome, getTriggerReport } from '../../src/services/mission-cognition/trigger-telemetry.js';
import { beginUsageCall, recordUsageResponse, usageSnapshot, runWithUsageOrigin } from '../../src/services/infrastructure/llm-usage-ledger.js';
import { dispatchUncertaintyTool } from '../../src/services/mission-cognition/mcp-tools.js';
import type { MissionState } from '../../src/types/cognitive-control.js';

const FAKE_DB = new FakeDb();
const db = FAKE_DB.asDb();

function seedMission(overrides: Partial<MissionState> = {}): MissionState {
  const state: MissionState = {
    schema_version: '1.0',
    mission_id: 'ph5_mission',
    version: 1,
    title: 'Phase 5 test mission',
    intent: 'test',
    status: 'active',
    owner_id: 'satori',
    success_criteria: [{ id: 'c1', description: 'x', status: 'unmet' }],
    authority_class: 'B',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  FAKE_DB.collection('mission_states').docs.push(structuredClone(state));
  return state;
}

function seedEntry(e: Record<string, any>): void {
  FAKE_DB.collection('epistemic_entries').docs.push({
    mission_id: 'ph5_mission',
    status: 'accepted',
    author_id: 'satori',
    confidence: 0.5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...e,
  });
}

afterEach(() => FAKE_DB.reset());

describe('trigger detectors — all nine, deterministic, no model calls (criteria 1-4)', () => {
  it('fires and near-misses per detector', async () => {
    // (i) mission_stalled — firing. The mission has to be old, because the whole
    // point of this detector is that it measures time, which (a)-(h) never do.
    seedMission({ created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
    // (a) repeated failure + stable/rising confidence — firing
    seedEntry({ entry_id: 'h1', entry_type: 'hypothesis', status: 'active', confidence: 0.9, statement: 'h', confidence_history: [
      { prior: 0.8, next: 0.9, reason: 'x', actor_id: 'satori', at: 't1' },
      { prior: 0.9, next: 0.9, reason: 'x', actor_id: 'satori', at: 't2' },
    ] });
    for (let i = 0; i < 3; i++) seedEntry({ entry_id: `f${i}`, entry_type: 'experiment', status: 'rejected', statement: 'failed', depends_on: ['h1'] });
    // (b) high confidence unsupported — firing
    seedEntry({ entry_id: 'a1', entry_type: 'assumption', status: 'accepted', statement: 'inherited', confidence: 0.9 });
    seedEntry({ entry_id: 'c1', entry_type: 'claim', status: 'accepted', confidence: 0.9, statement: 'confident claim', depends_on: ['a1'] });
    // (c) single hypothesis for high-impact decision — firing
    seedEntry({ entry_id: 'd1', entry_type: 'decision', status: 'accepted', confidence: 0.8, statement: 'decide', consequence_if_false: 'critical', depends_on: ['h1'] });
    // (d) contradictory evidence — firing
    seedEntry({ entry_id: 'e1', entry_type: 'evidence', status: 'accepted', statement: 'against', evidence_against: ['c1'] });
    // (e) unexpected experiment result — firing
    seedEntry({ entry_id: 'x1', entry_type: 'experiment', status: 'accepted', statement: 'exp', evidence_against: ['c1'] });
    // (f) plan unchanged despite evidence — firing (evidence after latest decision; no reaction)
    seedEntry({ entry_id: 'ev1', entry_type: 'evidence', status: 'accepted', statement: 'later evidence', created_at: new Date(Date.now() + 1000).toISOString() });
    // (g) critic disagreement — firing via explicit contradiction
    seedEntry({ entry_id: 'ct1', entry_type: 'contradiction', status: 'active', statement: 'disagreement recorded' });
    // (h) convergent agents — firing (same statement, two authors)
    seedEntry({ entry_id: 'cv1', entry_type: 'hypothesis', status: 'accepted', author_id: 'agent-a', statement: 'The fix is X' });
    seedEntry({ entry_id: 'cv2', entry_type: 'claim', status: 'accepted', author_id: 'agent-b', statement: 'The fix is X' });

    const { fired, byTrigger } = await evaluateTriggers(db, 'ph5_mission');
    for (const key of Object.keys(byTrigger)) {
      expect(byTrigger[key], `detector ${key} must fire on its fixture`).toBeGreaterThan(0);
    }
    // deterministic: identical state → identical set (criterion 3)
    const again = await evaluateTriggers(db, 'ph5_mission');
    expect(JSON.stringify(again.fired)).toBe(JSON.stringify(fired));
  });

  it('near-miss fixtures stay quiet (criterion 4 — no performative doubt)', async () => {
    seedMission();
    // (a) near-miss: 2 failures (below threshold)
    seedEntry({ entry_id: 'h1', entry_type: 'hypothesis', status: 'active', confidence: 0.5, statement: 'h', confidence_history: [
      { prior: 0.8, next: 0.5, reason: 'x', actor_id: 'satori', at: 't1' }, // falling confidence
    ] });
    for (let i = 0; i < 2; i++) seedEntry({ entry_id: `f${i}`, entry_type: 'experiment', status: 'rejected', statement: 'failed', depends_on: ['h1'] });
    // (b) near-miss: high confidence WITH direct evidence
    seedEntry({ entry_id: 'ev1', entry_type: 'evidence', status: 'accepted', statement: 'evidence' });
    seedEntry({ entry_id: 'c1', entry_type: 'claim', status: 'accepted', confidence: 0.95, statement: 'supported', evidence_for: ['ev1'] });
    // (c) near-miss: low-impact decision
    seedEntry({ entry_id: 'd1', entry_type: 'decision', status: 'accepted', confidence: 0.8, statement: 'decide', consequence_if_false: 'negligible', depends_on: ['h1'] });
    const { fired } = await evaluateTriggers(db, 'ph5_mission');
    expect(fired).toHaveLength(0);
  });

  it('near-miss fixtures for (d)-(h) stay quiet (criterion 4, complete coverage)', async () => {
    seedMission();
    // (d) near-miss: evidence with NO evidence_against (and predates the decision)
    seedEntry({ entry_id: 'ev-ok', entry_type: 'evidence', status: 'accepted', statement: 'harmless measurement', created_at: '2026-09-19T09:00:00.000Z' });
    // (e) near-miss: experiment with NO evidence_against
    seedEntry({ entry_id: 'exp-ok', entry_type: 'experiment', status: 'accepted', statement: 'experiment as expected' });
    // (f) near-miss: evidence AFTER the decision, but the plan REACTED (contradiction follows)
    const t0 = '2026-09-19T10:00:00.000Z';
    const t1 = '2026-09-19T11:00:00.000Z';
    const t2 = '2026-09-19T12:00:00.000Z';
    seedEntry({ entry_id: 'dec-ok', entry_type: 'decision', status: 'accepted', statement: 'decide', consequence_if_false: 'negligible', updated_at: t0 });
    seedEntry({ entry_id: 'ev-after', entry_type: 'evidence', status: 'accepted', statement: 'new info', created_at: t1 });
    seedEntry({ entry_id: 'react-ok', entry_type: 'contradiction', status: 'resolved', statement: 'we reacted to the new info', created_at: t2 });
    // (g) near-miss: contradiction already RESOLVED + no opposite-sign history anywhere
    // (h) near-miss: two hypotheses with DIFFERENT statements (no shared incumbent)
    seedEntry({ entry_id: 'hy1', entry_type: 'hypothesis', status: 'accepted', author_id: 'agent-a', statement: 'Throttling is per-IP' });
    seedEntry({ entry_id: 'hy2', entry_type: 'hypothesis', status: 'accepted', author_id: 'agent-b', statement: 'Throttling is per-region' });
    const { fired } = await evaluateTriggers(db, 'ph5_mission');
    expect(fired).toHaveLength(0);
  });

  it('detection path cannot reach the LLM — transitive import-graph walk (criterion 2, structural)', () => {
    // Verifier's option (a), now genuinely TRANSITIVE (carry-forward fix):
    // - extension-aware resolution: './collections.js' resolves to
    //   collections.ts on disk ([base, base.ts, base.tsx, base.js])
    // - bare side-effect imports are scanned too (/import\s+['"].../)
    // - dynamic import() stays out of scope, documented here explicitly
    // Verified able-to-fail in BOTH directions by mutation before landing:
    //   A. direct from-import of llm-service in the detector        -> RED
    //   B. detector -> helper that from-imports llm-service         -> RED
    const { resolve } = require('node:path') as typeof import('node:path');
    const { existsSync } = require('node:fs') as typeof import('node:fs');

    const ENTRY = 'src/services/mission-cognition/uncertainty-triggers.ts';
    const FORBIDDEN = /infrastructure[\\/]llm-service(\.ts|\.js)?$/;
    const visited = new Set<string>();
    const queue: string[] = [ENTRY];
    const reached: string[] = [];

    const resolveActual = (fromFile: string, spec: string): string | undefined => {
      const base = resolve(resolve(fromFile, '..'), spec.replace(/\.js$/, ''));
      return [base, base + '.ts', base + '.tsx', base + '.js'].find(existsSync);
    };

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf-8');
      const specs: string[] = [];
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
      for (const m of src.matchAll(/import\s+['"]([^'"]+)['"]/g)) specs.push(m[1]); // bare side-effect imports
      for (const spec of new Set(specs)) {
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // node built-ins / packages
        const actual = resolveActual(file, spec);
        if (!actual) continue; // genuinely unresolvable
        if (FORBIDDEN.test(actual)) reached.push(actual);
        queue.push(actual);
      }
    }

    expect(visited.size).toBeGreaterThan(1); // the walk really is transitive
    expect(reached).toHaveLength(0); // no transitive path reaches llm-service
  });
});

describe('dependency traversal (criteria 5-7)', () => {
  it('returns transitive dependents, cycle-safe, bound reported', async () => {
    seedMission();
    seedEntry({ entry_id: 'root', entry_type: 'assumption', statement: 'root' });
    seedEntry({ entry_id: 'mid1', entry_type: 'claim', statement: 'm1', depends_on: ['root'] });
    seedEntry({ entry_id: 'mid2', entry_type: 'claim', statement: 'm2', depends_on: ['root'] });
    seedEntry({ entry_id: 'leaf', entry_type: 'decision', statement: 'leaf', depends_on: ['mid1', 'mid2'] });
    seedEntry({ entry_id: 'cycle', entry_type: 'claim', statement: 'c', depends_on: ['leaf', 'cycle'] });
    const trace = await traceAssumptionDependencies(db, 'ph5_mission', 'root', 4);
    expect(trace.dependents).toEqual(expect.arrayContaining(['mid1', 'mid2', 'leaf', 'cycle']));
    expect(trace.cycle_detected).toBe(true); // cycle entry depends on itself
    expect(trace.depth_bound_applied).toBe(4);
  });
  it('invalidation reopens exactly the dependent set and suspends only affected work (7, 15, 16, 17)', async () => {
    seedMission();
    seedEntry({ entry_id: 'dec', entry_type: 'decision', status: 'accepted', statement: 'the decision', confidence: 0.9 });
    seedEntry({ entry_id: 'dep1', entry_type: 'claim', statement: 'depends', depends_on: ['dec'] });
    seedEntry({ entry_id: 'other', entry_type: 'claim', statement: 'unrelated' });
    FAKE_DB.collection('cognitive_work_items').docs.push(
      { work_item_id: 'w1', mission_id: 'ph5_mission', status: 'queued', description: 'work on dec' },
      { work_item_id: 'w2', mission_id: 'ph5_mission', status: 'queued', description: 'work on other' },
    );
    const result = await invalidateDecision(db, 'ph5_mission', 'dec', 'satori', 'assumption proven false');
    expect(result.dependent_entry_ids).toContain('dep1');
    expect(result.dependent_entry_ids).not.toContain('other');
    expect(result.suspended_work_items).toBe(1); // only w1 — scoped, never the whole mission
    // propagation via delta (criterion 15)
    const delta = FAKE_DB.collection('state_deltas').docs.find((d: any) => d.delta_type === 'DECISION_INVALIDATED');
    expect(delta).toBeTruthy();
    expect(delta.status).toBe('accepted');
    // plan preserved (criterion 17)
    expect(result.plan_preserved.entry_id).toBeTruthy();
    const blocked = FAKE_DB.collection('cognitive_work_items').docs.find((w: any) => w.work_item_id === 'w1');
    expect(blocked.status).toBe('blocked');
  });
});

describe('blind work items (criteria 8-11)', () => {
  it('carries no incumbent conclusion, rationale, or private material (9)', async () => {
    seedMission();
    seedEntry({ entry_id: 'u1', entry_type: 'uncertainty', status: 'active', statement: 'Which egress is throttled?', evidence_for: ['ev1'] });
    seedEntry({ entry_id: 'ev1', entry_type: 'evidence', status: 'accepted', statement: 'measurement data' });
    seedEntry({ entry_id: 'inc', entry_type: 'decision', status: 'accepted', statement: 'We will use egress A because the incumbent plan says so.' });
    seedEntry({ entry_id: 'rat', entry_type: 'claim', status: 'accepted', statement: 'incumbent rationale: A has always worked' });
    FAKE_DB.collection('agent_cognitive_profiles').docs.push({ agent_id: 'x', PRIVATE_SECRET: 'secret inner reflection about the favoured answer' });

    const brief = await buildBlindBrief(db, 'ph5_mission', 'u1');
    const item = await createBlindWorkItem(db, 'ph5_mission', 'u1', brief);
    const payload = JSON.stringify(item) + ' ' + JSON.stringify(brief);
    assertBlindPayloadClean(payload, ['egress A', 'incumbent plan', 'has always worked', 'secret inner reflection']);
    expect((item as any).independence_requirement ?? (FAKE_DB.collection('cognitive_work_items').docs[0] as any).independence_requirement).toBe('blind_parallel');
  });
  it('two blind workers share no incumbent cross-information (10)', async () => {
    seedMission();
    seedEntry({ entry_id: 'u1', entry_type: 'uncertainty', status: 'active', statement: 'Which egress is throttled?' });
    const a = await createBlindWorkItem(db, 'ph5_mission', 'u1');
    const b = await createBlindWorkItem(db, 'ph5_mission', 'u1');
    expect(a.work_item_id).not.toBe(b.work_item_id);
    // neither payload mentions the other worker or any hypothesis statement
    expect(JSON.stringify(a)).not.toContain(b.work_item_id);
    expect(JSON.stringify(b)).not.toContain(a.work_item_id);
    expect(JSON.stringify(a)).not.toContain('incumbent');
    // reopening queues review — statuses are queued, nothing auto-resumes (11)
    expect(a.status).toBe('queued');
    expect(b.status).toBe('queued');
  });
  it('reference set is an ALLOW-list: contradiction/result/unknown never reach the worker (risk finding)', async () => {
    seedMission();
    seedEntry({ entry_id: 'u1', entry_type: 'uncertainty', status: 'active', statement: 'Which egress is throttled?', evidence_for: ['ev1', 'res1', 'ct1', 'unk1'] });
    seedEntry({ entry_id: 'ev1', entry_type: 'evidence', status: 'accepted', statement: 'measurement data' });
    seedEntry({ entry_id: 'res1', entry_type: 'result', status: 'accepted', statement: 'the experiment showed the incumbent answer was right' });
    seedEntry({ entry_id: 'ct1', entry_type: 'contradiction', status: 'active', statement: 'this contradicts the incumbent plan' });
    seedEntry({ entry_id: 'unk1', entry_type: 'unknown', status: 'accepted', statement: 'unknown detail about the incumbent' });
    const brief = await buildBlindBrief(db, 'ph5_mission', 'u1');
    expect(brief.references).toEqual(['ev1']); // ONLY the evidence id — everything else withheld
    const payload = JSON.stringify(brief) + ' ' + JSON.stringify(await createBlindWorkItem(db, 'ph5_mission', 'u1', brief));
    assertBlindPayloadClean(payload, ['incumbent answer was right', 'contradicts the incumbent', 'unknown detail']);
  });
  it('feature vector derives from the uncertainty entry (smaller-item A)', async () => {
    seedMission();
    seedEntry({ entry_id: 'u-crit', entry_type: 'uncertainty', status: 'active', statement: 'critical question', consequence_if_false: 'critical', information_needed: ['x', 'y'] });
    seedEntry({ entry_id: 'u-neg', entry_type: 'uncertainty', status: 'active', statement: 'minor question', consequence_if_false: 'negligible' });
    const crit = await buildBlindBrief(db, 'ph5_mission', 'u-crit');
    const neg = await buildBlindBrief(db, 'ph5_mission', 'u-neg');
    expect(crit.features.mission_impact).toBe(3);
    expect(crit.features.urgency).toBe(2);
    expect(crit.features.information_value).toBe(3); // 1 + min(2 info-needed, 8)
    expect(neg.features.mission_impact).toBe(1);
    expect(neg.features.urgency).toBe(1);
  });
});

describe('hypothesis diversity (criteria 12-14)', () => {
  it('measures over submitted hypotheses; acceptance requires falsifiable form + evidence', async () => {
    seedMission();
    seedEntry({ entry_id: 'h1', entry_type: 'hypothesis', status: 'accepted', author_id: 'a1', statement: 'If throttling is per-IP, a second IP will also get 429', evidence_for: ['ev1'] });
    seedEntry({ entry_id: 'h2', entry_type: 'hypothesis', status: 'accepted', author_id: 'a2', statement: 'If throttling is per-region, a second IP will succeed', evidence_for: ['ev1'] });
    seedEntry({ entry_id: 'h3', entry_type: 'hypothesis', status: 'proposed', statement: 'somehow it works' }); // not submitted — excluded
    seedEntry({ entry_id: 'h4', entry_type: 'hypothesis', status: 'accepted', author_id: 'a1', statement: 'things might improve' }); // generic → flagged
    const r = await measureHypothesisDiversity(db, 'ph5_mission');
    expect(r.submitted_count).toBe(3); // h3 excluded (criterion 12)
    expect(r.distinct_authors).toBe(2);
    expect(r.distinct_forms).toBe(3);
    expect(r.flagged_not_falsifiable).toContain('h4'); // criterion 14
    expect(assessHypothesisAcceptance({ entry_id: 'h1', statement: 'If X then Y', status: 'accepted', evidence_for: ['e'] }).acceptable).toBe(true);
    expect(assessHypothesisAcceptance({ entry_id: 'h4', statement: 'things might improve', status: 'accepted' }).acceptable).toBe(false);
  });
  it('commit boundary: worker B cannot see worker A’s uncommitted hypothesis (criterion 13)', async () => {
    seedMission();
    // Worker A has an uncommitted (proposed) hypothesis; committed ones exist from others.
    seedEntry({ entry_id: 'hA-uncommitted', entry_type: 'hypothesis', status: 'proposed', author_id: 'worker-a', statement: 'A’s unpublished idea: if X then Y' });
    seedEntry({ entry_id: 'hB-committed', entry_type: 'hypothesis', status: 'accepted', author_id: 'worker-b', statement: 'If throttling is per-IP, a second IP will also get 429', evidence_for: ['ev1'] });
    // Worker B runs the comparison path — the pure read of persisted state.
    const r = await measureHypothesisDiversity(db, 'ph5_mission');
    expect(r.submitted_count).toBe(1); // only the committed one — A’s idea invisible
    expect(JSON.stringify(r)).not.toContain('unpublished idea');
  });
});

describe('experiment registry (criteria 18-19)', () => {
  it('proposes with separating hypotheses; contradicting result opens a contradiction', async () => {
    seedMission();
    seedEntry({ entry_id: 'h1', entry_type: 'hypothesis', status: 'accepted', statement: 'per-IP' });
    seedEntry({ entry_id: 'h2', entry_type: 'hypothesis', status: 'accepted', statement: 'per-region' });
    const exp = await proposeExperiment(db, 'ph5_mission', 'satori', 'Test a second egress IP', ['h1', 'h2']);
    expect(exp.depends_on).toEqual(['h1', 'h2']); // which hypotheses it separates (18)
    const listed = await listExperiments(db, 'ph5_mission');
    expect(listed.map(e => e.entry_id)).toContain(exp.entry_id);
    const resolved = await resolveExperiment(db, 'ph5_mission', exp.entry_id, 'satori', {
      summary: 'second IP also 429',
      contradicts_entry_id: 'h2',
    });
    expect(resolved.result?.contradicts_entry_id).toBe('h2');
    const contradictions = FAKE_DB.collection('epistemic_entries').docs.filter((e: any) => e.entry_type === 'contradiction');
    expect(contradictions.length).toBe(1); // opened, not silent overwrite (19)
  });
});

describe('trigger telemetry (criteria 20-21)', () => {
  it('records outcome with measured token cost and computes precision', async () => {
    seedMission();
    const before = usageSnapshot();
    await runWithUsageOrigin({ mission_id: 'ph5_mission' }, async () => {
      const id = beginUsageCall('deepseek', 'm');
      recordUsageResponse(id, { input_tokens: 400, output_tokens: 100 });
    });
    const rec = await recordTriggerOutcome(db, {
      trigger: 'material_contradictory_evidence',
      mission_id: 'ph5_mission',
      reason: 't',
    }, 'useful_information', 'found real contradiction', before);
    expect(rec.token_cost).toBe(500); // measured from the ledger, never estimated (20)
    await recordTriggerOutcome(db, { trigger: 'critic_disagreement', mission_id: 'ph5_mission', reason: 't' }, 'mere_variance');
    const report = await getTriggerReport(db, 'ph5_mission');
    expect(report.fires).toBe(2);
    expect(report.useful).toBe(1);
    expect(report.performative).toBe(1);
    expect(report.cost_per_useful_trigger).toBe(500); // (21)
  });
});

describe('safety (criteria 22-24)', () => {
  it('uncertainty tools are unreachable when either flag is off — plain Unknown tool (24)', async () => {
    delete process.env.COGNITIVE_SCHEDULER_MODE;
    process.env.COGNITIVE_CONTROL_ENABLED = 'write';
    await expect(
      dispatchUncertaintyTool('evaluate_triggers', { mission_id: 'x' }, { user_id: 'satori', trusted: true }),
    ).rejects.toThrow('Unknown tool: evaluate_triggers');
    process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
    process.env.COGNITIVE_CONTROL_ENABLED = 'off';
    await expect(
      dispatchUncertaintyTool('list_uncertainties', { mission_id: 'x' }, { user_id: 'satori', trusted: true }),
    ).rejects.toThrow('Unknown tool: list_uncertainties');
    delete process.env.COGNITIVE_SCHEDULER_MODE;
    delete process.env.COGNITIVE_CONTROL_ENABLED;
  });
  it('scheduler mode ladder: Phase 6 modes parse, unimplemented + kill switch fail closed (22)', async () => {
    const { schedulerMode } = await import('../../src/services/mission-cognition/index.js');
    process.env.COGNITIVE_SCHEDULER_MODE = 'recommend';
    expect(schedulerMode()).toBe('recommend');
    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    expect(schedulerMode()).toBe('allocate_internal');
    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_gated';
    expect(schedulerMode()).toBe('off'); // not implemented (§4.6)
    // Kill switch overrides every other flag (contract §4.10).
    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    process.env.COGNITIVE_ACTIVATION_KILL_SWITCH = '1';
    expect(schedulerMode()).toBe('off');
    delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
    delete process.env.COGNITIVE_SCHEDULER_MODE;
  });
  it('no new module imports the live allocator (23)', () => {
    for (const f of [
      'src/services/mission-cognition/uncertainty-triggers.ts',
      'src/services/mission-cognition/dependency-traversal.ts',
      'src/services/mission-cognition/blind-work.ts',
      'src/services/mission-cognition/hypothesis-diversity.ts',
      'src/services/mission-cognition/invalidation.ts',
      'src/services/mission-cognition/experiment-registry.ts',
      'src/services/mission-cognition/trigger-telemetry.ts',
    ]) {
      const src = readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/from\s+['"][^'"]*autonomous-executive/);
      expect(src).not.toMatch(/require\([^)]*autonomous-executive/);
    }
  });
});
