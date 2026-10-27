/**
 * ITER-11, WS-5 item 3 — the types, the salience identity stamping and the
 * novelty-drive replenishment.
 *
 * Contract: "`types/memory.ts` gains the new artifact types; `salience-service.ts`
 * gains identity stamping + persisted trace-ready inputs (kept separate from
 * ingestion gating); `motivational-engine.ts` gains bounded coverage/useful-
 * outcome novelty replenishment (per-identity guarded as far as existing state
 * allows — document the limit)."
 *
 * Every assertion fails against the pre-iteration sources: `types/memory.ts`
 * had no ITER-11 artifacts (and no validators), `SalienceService` had no
 * `computeStampedSalience`/`persistSalienceInput`, and `MotivationalEngine` had
 * no `applyNoveltyReplenishment` (nothing fed coverage into the drive).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  ITER11_ARTIFACT_BOUNDS,
  validateDeltaProposalRow,
  validateDeprecationEventRow,
  validateFailureSignature,
  validateNoveltyReplenishment,
  validateTraceReadySalienceInput,
} from '../../src/types/memory.js';
import {
  MAX_TRACE_READY_INPUTS,
  SALIENCE_INPUT_COLLECTION,
  SalienceService,
  listTraceReadyInputs,
  persistSalienceInput,
} from '../../src/services/processing/salience-service.js';
import {
  NOVELTY_REPLENISHMENT_BOUND,
  MotivationalEngine,
} from '../../src/services/processing/motivational-engine.js';
import { FakeDb } from '../helpers/fake-mongo.js';
import { PERSONAL_KINDS } from '../../src/services/memory/write-scope-policy.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: 'agent-a', trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

describe('types/memory.ts — the new artifacts, with validation', () => {
  it('accepts a well-formed row of every new artifact', () => {
    expect(
      validateFailureSignature({
        schema_version: '1.0',
        kind: 'failure_signature',
        signature_id: 'fsig_x',
        user_id: 'agent-a',
        mission_id: 'm1',
        seed_id: 'seed_1',
        operator: 'assumption_inversion',
        signature: 'unnecessary_cost_assumption_inversion',
        detail: 'the probe settled nothing',
        count: 2,
        first_seen_at: '2026-09-26T00:00:00.000Z',
        last_seen_at: '2026-09-26T01:00:00.000Z',
      }).valid,
    ).toBe(true);
    expect(
      validateTraceReadySalienceInput({
        schema_version: '1.0',
        kind: 'salience_input',
        input_id: 'sal_1',
        user_id: 'agent-a',
        mission_id: null,
        meta_state: 'exploration',
        signals: { recency: 1, novelty: 0.5 },
        weights: { novelty: 0.35 },
        score: 0.6,
        tier: 'medium',
        threshold: 0.55,
        created_at: '2026-09-26T00:00:00.000Z',
      }).valid,
    ).toBe(true);
    expect(
      validateNoveltyReplenishment({
        user_id: 'agent-a',
        mission_id: 'm1',
        before: 0.7,
        after: 0.69,
        applied: -0.01,
        coverage_component: -0.01,
        waste_component: 0,
        useful_component: 0,
        bound: NOVELTY_REPLENISHMENT_BOUND,
        basis: 'x',
      }).valid,
    ).toBe(true);
    expect(
      validateDeltaProposalRow({
        proposal_id: 'pdelta_1',
        user_id: 'agent-a',
        status: 'proposed',
        dimension: 'vector_fetch_limit',
        applied: false,
        autonomous_application: 'forbidden',
        created_at: '2026-09-26T00:00:00.000Z',
      }).valid,
    ).toBe(true);
    expect(
      validateDeprecationEventRow({
        event_key: 'deprecation:legacy_read:agent-a:2026-09-26',
        user_id: 'agent-a',
        kind: 'legacy_read',
        count: 1,
        first_seen_at: '2026-09-26T00:00:00.000Z',
        last_seen_at: '2026-09-26T00:00:00.000Z',
        expires_at: '2026-10-26T00:00:00.000Z',
      }).valid,
    ).toBe(true);
  });

  it('refuses the ways a row can go wrong — including text smuggled into a numbers-only row', () => {
    const badSignature = validateFailureSignature({ signature_id: 'x', user_id: 'agent-a', signature: 'Not A Slug' });
    expect(badSignature.valid).toBe(false);
    expect(badSignature.errors.join(' | ')).toContain('signature');

    const withText = validateTraceReadySalienceInput({
      input_id: 'sal_1',
      user_id: 'agent-a',
      mission_id: null,
      meta_state: 'idle',
      signals: { novelty: 1 },
      weights: {},
      score: 1,
      tier: 'high',
      threshold: 0.5,
      created_at: '2026-09-26T00:00:00.000Z',
      statement: 'a private reflection body',
    });
    expect(withText.valid).toBe(false);
    expect(withText.errors.join(' | ')).toContain('numbers only');

    const outOfBound = validateNoveltyReplenishment({
      user_id: 'agent-a',
      mission_id: null,
      before: 0.7,
      after: 0.2,
      applied: -0.5,
      bound: 0.1,
    });
    expect(outOfBound.valid).toBe(false);
    expect(outOfBound.errors.join(' | ')).toContain('exceeds its own bound');

    const appliedProposal = validateDeltaProposalRow({
      proposal_id: 'p',
      user_id: 'agent-a',
      status: 'proposed',
      dimension: 'x',
      applied: true,
      autonomous_application: 'allowed',
      created_at: '2026-09-26T00:00:00.000Z',
    });
    expect(appliedProposal.valid).toBe(false);
    expect(appliedProposal.errors.join(' | ')).toContain('never applied');

    // A TTL row that expires before it is first seen is a contradiction.
    const badTtl = validateDeprecationEventRow({
      event_key: 'k',
      user_id: 'agent-a',
      kind: 'legacy_read',
      count: 1,
      first_seen_at: '2026-09-26T00:00:00.000Z',
      last_seen_at: '2026-09-26T00:00:00.000Z',
      expires_at: '2026-09-25T00:00:00.000Z',
    });
    expect(badTtl.valid).toBe(false);
    expect(badTtl.errors.join(' | ')).toContain('after first_seen_at');

    expect(ITER11_ARTIFACT_BOUNDS.max_failure_signatures).toBeGreaterThan(0);
    expect(ITER11_ARTIFACT_BOUNDS.max_trace_ready_inputs).toBe(MAX_TRACE_READY_INPUTS);
  });
});

describe('salience-service — identity stamping and trace-ready inputs', () => {
  it('stamps the SAME computation with the identity, changing nothing about it', () => {
    const service = SalienceService.get_instance();
    service.setMetaState('exploration');
    const params = { hoursSinceEvent: 3, emotionalIntensity: 0.6, goalRelevance: 0.4, novelty: 0.9, confidence: 0.7 };

    const plain = service.computeSalience(params);
    const stamped = service.computeStampedSalience(params, { user_id: 'agent-a', mission_id: 'm1' }, '2026-09-26T00:00:00.000Z');
    // The result is the same computation, field for field (except the ring
    // buffer's own history, which is not part of the result).
    expect(stamped.result).toEqual(plain);
    expect(stamped.trace_ready.user_id).toBe('agent-a');
    expect(stamped.trace_ready.mission_id).toBe('m1');
    expect(stamped.trace_ready.score).toBe(plain.score);
    expect(stamped.trace_ready.signals).toEqual(plain.signals);
    expect(stamped.trace_ready.input_id).toMatch(/^sal_[0-9a-f]{16}$/);
    // Derived: the same computation stamps to the same id.
    const again = service.computeStampedSalience(params, { user_id: 'agent-a', mission_id: 'm1' }, '2026-09-26T00:01:00.000Z');
    expect(again.trace_ready.input_id).toBe(stamped.trace_ready.input_id);
    // NUMBERS ONLY: no statement/narrative field exists on the row.
    expect(validateTraceReadySalienceInput(stamped.trace_ready).valid).toBe(true);
    expect(JSON.stringify(stamped.trace_ready)).not.toContain('statement');
  });

  it('persists per identity, bounded, and never with a shared id', async () => {
    const service = SalienceService.get_instance();
    service.setMetaState('task_execution');
    const base = { hoursSinceEvent: 1, novelty: 0.5, confidence: 0.5 };
    const inputs = Array.from({ length: MAX_TRACE_READY_INPUTS + 3 }, (_v, index) =>
      service.computeStampedSalience(
        { ...base, goalRelevance: index / 1000 },
        { user_id: 'agent-a', mission_id: 'm1' },
        new Date(Date.UTC(2026, 8, 26, 0, index)).toISOString(),
      ).trace_ready,
    );

    let last: Awaited<ReturnType<typeof persistSalienceInput>> | null = null;
    let prunedTotal = 0;
    for (const input of inputs) {
      last = await persistSalienceInput(db.asDb(), input, { caller: OWNER });
      expect(last.persisted).toBe(true);
      prunedTotal += last.pruned;
    }
    const rows = db.collection(SALIENCE_INPUT_COLLECTION).docs as Array<Record<string, any>>;
    expect(rows.length).toBe(MAX_TRACE_READY_INPUTS);
    // Every one of the three overflow rows was pruned and COUNTED.
    expect(prunedTotal).toBe(3);
    expect(last!.rows).toBe(MAX_TRACE_READY_INPUTS);
    expect(rows.every((row) => (row.shared_id ?? null) === null)).toBe(true);
    expect(PERSONAL_KINDS).toContain(SALIENCE_INPUT_COLLECTION);

    // A foreign caller cannot persist into another identity's rows.
    const foreign = await persistSalienceInput(db.asDb(), inputs[0], { caller: OTHER });
    expect(foreign.persisted).toBe(false);
    expect(foreign.code).toBe('untrusted_caller');

    // Reads are per identity and bounded.
    expect(await listTraceReadyInputs(db.asDb(), 'agent-a')).toHaveLength(MAX_TRACE_READY_INPUTS);
    expect(await listTraceReadyInputs(db.asDb(), 'agent-b')).toHaveLength(0);
    const scoped = await listTraceReadyInputs(db.asDb(), 'agent-a', { missionId: 'm1', limit: 5 });
    expect(scoped).toHaveLength(5);
    expect(await listTraceReadyInputs(db.asDb(), 'agent-a', { missionId: 'other' })).toHaveLength(0);
  });
});

describe('motivational-engine — bounded coverage/useful novelty replenishment', () => {
  it('depletes the drive for an unexplored archive and replenishes it for useful outcomes, bounded', () => {
    const engine = MotivationalEngine.get_instance();
    const start = engine.getDriveState().novelty.current;

    const unexplored = engine.applyNoveltyReplenishment({
      user_id: 'agent-a',
      mission_id: 'm1',
      coverage_cells: 0,
      coverage_target: 10,
      useful_outcomes: 0,
      wasted_outcomes: 0,
    });
    expect(unexplored.applied).toBeLessThan(0);
    expect(unexplored.applied).toBeGreaterThanOrEqual(-NOVELTY_REPLENISHMENT_BOUND);
    expect(engine.getDriveState().novelty.current).toBeLessThan(start);
    expect(validateNoveltyReplenishment(unexplored).valid).toBe(true);

    const satisfied = engine.applyNoveltyReplenishment({
      user_id: 'agent-a',
      mission_id: 'm1',
      coverage_cells: 12,
      coverage_target: 10,
      useful_outcomes: 2,
      wasted_outcomes: 0,
    });
    expect(satisfied.coverage_component).toBe(0); // a saturated archive adds nothing
    expect(satisfied.applied).toBeGreaterThan(0);
    expect(engine.getDriveState().novelty.current).toBeGreaterThan(unexplored.after);

    // A HOSTILE input (a thousand wasted outcomes) cannot move it past the bound.
    const flooded = engine.applyNoveltyReplenishment({
      user_id: 'agent-a',
      mission_id: 'm1',
      coverage_cells: 0,
      coverage_target: 1,
      useful_outcomes: 0,
      wasted_outcomes: 1000,
    });
    expect(flooded.applied).toBe(-NOVELTY_REPLENISHMENT_BOUND);
    expect(flooded.bound).toBe(NOVELTY_REPLENISHMENT_BOUND);
    // The limit is documented on the result: one shared drive, the identity
    // recorded rather than keyed.
    expect(flooded.user_id).toBe('agent-a');
    expect(flooded.basis).toContain('process-wide singleton');
    expect(flooded.basis).toContain('SHARED novelty drive');
  });
});
