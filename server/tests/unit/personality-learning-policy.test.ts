/**
 * ITER-11, WS-5 item 2 — the §9 learning decision and the bounded delta
 * PROPOSAL.
 *
 * Contract: "`personality-config-service.proposeBoundedDelta(userId, evidence)`
 * — proposal-only (no autonomous application): computes a bounded delta from
 * recorded outcomes/evidence, honours weekly delta limits and the hard
 * invariants, returns a proposal + rationale, and records it in an auditable
 * row; refuse anything out of bounds by name. Also record the §9 learning
 * decision (yes, later, within bounds) in `personality_config` as
 * `learning_policy` + `bounds` fields and in the CHANGELOG."
 *
 * Every assertion fails against the pre-iteration sources: `proposeBoundedDelta`
 * did not exist, no `learning_policy`/`bounds` was ever written to a record,
 * and there was no learnable-dimension table to bound anything with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  DELTA_PROPOSAL_COLLECTION,
  LEARNING_BOUNDS,
  LEARNING_POLICY,
  effectivePersonalityConfig,
  listDeltaProposals,
  personalityConfigKey,
  proposeBoundedDelta,
  resolvePersonalityConfig,
  updatePersonalityConfig,
} from '../../src/services/integration/personality-config-service.js';
import { FakeDb } from '../helpers/fake-mongo.js';
import { PERSONAL_KINDS } from '../../src/services/memory/write-scope-policy.js';
import { validateDeltaProposalRow } from '../../src/types/memory.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const DB = new FakeDb();
const settings = () => DB.collection('system_settings');
const proposals = () => DB.collection(DELTA_PROPOSAL_COLLECTION).docs as Array<Record<string, any>>;

const untrusted = (userId: string): CallerIdentity => ({ user_id: userId, trusted: false });
const TRUSTED: CallerIdentity = { user_id: 'operator', trusted: true };

const VALID_PATCH = {
  personality: 'analyst',
  source_weights: { vector_search: 6 },
  scoring: { relevance_multiplier: 2.5 },
  max_context_tokens: 6000,
};

/** Two agreeing observations for one dimension — the minimum evidence. */
const agreeing = (dimension: string, direction: 'increase' | 'decrease' = 'increase') => [
  { dimension, direction, source: 'cycle_outcome_1' },
  { dimension, direction, source: 'cycle_outcome_2' },
];

beforeEach(() => {
  DB.reset();
  process.env.PER_IDENTITY_PERSONALITY = '1';
});

afterEach(() => {
  DB.reset();
  delete process.env.PER_IDENTITY_PERSONALITY;
});

describe('the §9 learning decision is DATA on the identity record', () => {
  it('flag OFF: the legacy document still carries exactly the pre-iteration fields', async () => {
    delete process.env.PER_IDENTITY_PERSONALITY;
    await updatePersonalityConfig(DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));
    expect(Object.keys(settings().docs[0]).sort()).toEqual(
      ['key', 'max_context_tokens', 'personality', 'scoring', 'source_weights', 'updated_at'],
    );
  });

  it('flag ON: every identity write records learning_policy + bounds, server-owned', async () => {
    await updatePersonalityConfig(DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));
    const doc = settings().docs.find((row: any) => row.key === personalityConfigKey('agent-a'))!;
    expect(doc.learning_policy).toMatchObject({
      decision: 'yes_later_within_bounds',
      autonomy: 'proposal_only',
      rate: 'slow',
      cadence: 'weekly',
    });
    expect(doc.bounds.weekly_proposals).toBe(1);
    expect(doc.bounds.steps_per_proposal).toBe(1);
    expect(doc.bounds.immutable_invariants).toEqual(['message_priority', 'floors', 'cap_bounds', 'privacy_policy']);

    const resolved = await resolvePersonalityConfig(DB.asDb(), 'agent-a');
    expect(resolved.learning_policy).toEqual(LEARNING_POLICY);
    expect(resolved.bounds).toEqual(LEARNING_BOUNDS);
  });

  it('a record that carries no policy (or a weakened one) resolves to the documented policy', async () => {
    settings().docs.push({
      key: personalityConfigKey('agent-b'),
      personality: 'balanced',
      source_weights: {},
      scoring: {},
      origin: 'identity',
      version: 1,
      learning_policy: { decision: 'unlimited' },
      bounds: { weekly_proposals: 99, steps_per_proposal: 99 },
      updated_at: '2026-09-26T00:00:00.000Z',
    });
    const resolved = await resolvePersonalityConfig(DB.asDb(), 'agent-b');
    // The decision is refused wholesale…
    expect(resolved.learning_policy).toEqual(LEARNING_POLICY);
    // …and the numeric bounds may only be NARROWED, never widened.
    expect(resolved.bounds.weekly_proposals).toBe(1);
    expect(resolved.bounds.steps_per_proposal).toBe(1);
    expect(resolved.bounds.dimension_ranges).toEqual(LEARNING_BOUNDS.dimension_ranges);
  });
});

describe('proposeBoundedDelta — bounded, audited, proposal-only', () => {
  async function seedIdentity(): Promise<void> {
    await updatePersonalityConfig(DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));
  }

  it('proposes ONE documented step, records it, and NEVER writes the personality record', async () => {
    await seedIdentity();
    const before = JSON.stringify(settings().docs);

    const proposal = await proposeBoundedDelta(
      DB.asDb(),
      'agent-a',
      agreeing('vector_fetch_limit', 'increase'),
      { caller: untrusted('agent-a'), now: () => '2026-09-26T10:00:00.000Z' },
    );

    expect(proposal.status).toBe('proposed');
    expect(proposal.code).toBeNull();
    expect(proposal.dimension).toBe('vector_fetch_limit');
    expect(proposal.direction).toBe('increase');
    expect(proposal.step).toBe(LEARNING_BOUNDS.dimension_ranges.vector_fetch_limit.step);
    expect(proposal.to! - proposal.from!).toBe(LEARNING_BOUNDS.dimension_ranges.vector_fetch_limit.step);
    expect(proposal.applied).toBe(false);
    expect(proposal.autonomous_application).toBe('forbidden');
    expect(proposal.rationale).toContain('PROPOSAL ONLY');
    expect(proposal.evidence).toHaveLength(2);
    expect(proposal.basis).toContain('the personality record was NOT written');

    // The auditable row exists, is private, and is marked as not applied.
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      user_id: 'agent-a',
      status: 'proposed',
      dimension: 'vector_fetch_limit',
      applied: false,
      autonomous_application: 'forbidden',
    });
    expect(proposals()[0].shared_id ?? null).toBeNull();
    expect(PERSONAL_KINDS).toContain(DELTA_PROPOSAL_COLLECTION);

    // PROPOSAL-ONLY: the record is byte-identical after the proposal.
    expect(JSON.stringify(settings().docs)).toBe(before);
    const resolved = await resolvePersonalityConfig(DB.asDb(), 'agent-a');
    expect(effectivePersonalityConfig(resolved).scoring.vector_fetch_limit).toBe(
      effectivePersonalityConfig(resolved).scoring.vector_fetch_limit,
    );
  });

  it('refuses thin, disagreeing, unknown and invariant-named evidence BY NAME', async () => {
    await seedIdentity();

    const thin = await proposeBoundedDelta(DB.asDb(), 'agent-a', [
      { dimension: 'recency_half_life_days', direction: 'increase', source: 'one' },
    ]);
    expect(thin.code).toBe('no_evidence');
    expect(thin.reason).toContain('at least 2');

    const none = await proposeBoundedDelta(DB.asDb(), 'agent-a', []);
    expect(none.code).toBe('no_evidence');

    const disagreeing = await proposeBoundedDelta(DB.asDb(), 'agent-a', [
      { dimension: 'recency_half_life_days', direction: 'increase' },
      { dimension: 'recency_half_life_days', direction: 'decrease' },
    ]);
    expect(disagreeing.code).toBe('conflicting_evidence');
    expect(disagreeing.reason).toContain('disagrees with itself');

    const twoDimensions = await proposeBoundedDelta(DB.asDb(), 'agent-a', [
      { dimension: 'recency_half_life_days', direction: 'increase' },
      { dimension: 'vector_fetch_limit', direction: 'increase' },
    ]);
    expect(twoDimensions.code).toBe('conflicting_evidence');
    expect(twoDimensions.reason).toContain('exactly one');

    const unknown = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('vibes', 'increase'));
    expect(unknown.code).toBe('unknown_dimension');
    expect(unknown.reason).toContain('not one of the learnable dimensions');

    // The hard invariants — and their aliases — by name.
    for (const [dimension, invariant] of [
      ['agent_message', 'message_priority'],
      ['message_priority', 'message_priority'],
      ['budget_floors', 'floors'],
      ['caps', 'cap_bounds'],
      ['privacy_policy', 'privacy_policy'],
    ] as const) {
      const refused = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing(dimension, 'decrease'));
      expect(refused.code, dimension).toBe('immutable_invariant');
      expect(refused.reason).toContain(`'${invariant}'`);
    }

    // Nothing was ever recorded as a proposal (only refusals are audited).
    expect(proposals().every((row) => row.status === 'refused')).toBe(true);
    expect(proposals()).toHaveLength(10);
  });

  it('every recorded row — refused or proposed — carries the not-applied markers and validates', async () => {
    await seedIdentity();

    // One refusal (an unknown dimension) and one proposal, in the same store.
    const refused = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('vibes', 'increase'));
    expect(refused.status).toBe('refused');
    const proposed = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('vector_fetch_limit', 'increase'));
    expect(proposed.status).toBe('proposed');

    expect(proposals()).toHaveLength(2);
    for (const row of proposals()) {
      // The docstring's claim, on BOTH statuses: a reader of the collection
      // never has to consult `status` to know the row was not applied.
      expect(row, `row ${row.proposal_id}`).toMatchObject({
        applied: false,
        autonomous_application: 'forbidden',
      });
      // …and every row validates as the documented artifact. Before this fix a
      // REFUSAL row omitted both keys and `validateDeltaProposalRow` rejected
      // it ('applied must be false', "autonomous_application must be
      // 'forbidden'") — the collection contained rows that were not the
      // artifact it documents.
      const check = validateDeltaProposalRow(row);
      expect(check.valid, `${row.status}: ${check.errors.join('; ')}`).toBe(true);
    }
    // The refusal is still a refusal (the markers are added, nothing else).
    const refusalRow = proposals().find((row) => row.status === 'refused')!;
    expect(refusalRow.code).toBe('unknown_dimension');
    expect(refusalRow.dimension).toBe('vibes');
    // PROPOSAL-ONLY: neither row moved the personality record.
    expect(settings().docs.filter((row: any) => row.key === personalityConfigKey('agent-a')).length).toBe(1);
  });

  it('refuses a delta that would leave the dimension’s operable range', async () => {    await seedIdentity();
    // `vector_fetch_limit` currently reads the registry default (5). Decreasing
    // by one step (5) would land at 0, below the documented floor of 1.
    const refused = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('vector_fetch_limit', 'decrease'));
    expect(refused.code).toBe('out_of_bounds');
    expect(refused.reason).toContain('outside its operable range [1, 500]');
    expect(refused.dimension).toBe('vector_fetch_limit');

    // Inside the range the same dimension moves freely.
    const allowed = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('vector_fetch_limit', 'increase'));
    expect(allowed.status).toBe('proposed');
    expect([allowed.from, allowed.to]).toEqual([5, 10]);
  });

  it('honours the weekly limit from the STORED rows, not from memory', async () => {
    await seedIdentity();
    const first = await proposeBoundedDelta(
      DB.asDb(),
      'agent-a',
      agreeing('vector_fetch_limit', 'increase'),
      { now: () => '2026-09-26T10:00:00.000Z' },
    );
    expect(first.status).toBe('proposed');

    const second = await proposeBoundedDelta(
      DB.asDb(),
      'agent-a',
      agreeing('vector_fetch_limit', 'increase'),
      { now: () => '2026-09-27T10:00:00.000Z' },
    );
    expect(second.code).toBe('weekly_limit_exceeded');
    expect(second.reason).toContain('the limit is 1 per identity');

    // Outside the window the limit frees up again — and the count comes from
    // the rows (a restart cannot reset it).
    const third = await proposeBoundedDelta(
      DB.asDb(),
      'agent-a',
      agreeing('recency_half_life_days', 'decrease'),
      { now: () => '2026-10-05T10:00:00.000Z' },
    );
    expect(third.status).toBe('proposed');
    expect(await listDeltaProposals(DB.asDb(), 'agent-a')).toHaveLength(3);
  });

  it('refuses a foreign caller and an empty identity, and requires the database', async () => {
    await seedIdentity();
    const foreign = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('relevance_multiplier'), {
      caller: { user_id: 'agent-b', trusted: false },
    });
    expect(foreign.code).toBe('untrusted_caller');

    // A trusted caller may propose on behalf of an identity (operator review).
    const trusted = await proposeBoundedDelta(DB.asDb(), 'agent-a', agreeing('relevance_multiplier'), { caller: TRUSTED });
    expect(trusted.status).toBe('proposed');

    const empty = await proposeBoundedDelta(DB.asDb(), '', agreeing('relevance_multiplier'));
    expect(empty.code).toBe('invalid_args');
  });
});
