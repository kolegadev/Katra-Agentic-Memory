/**
 * Unit tests — long-horizon cognitive control plane (Phase 1-2, local testing).
 * Covers the core invariants from handoff doc 05: monotonic versions, exactly-once
 * delta application, stale-version conflict without dropping proposals, immutable
 * confidence history, blind batons, secret rejection, stale-baton revocation,
 * deterministic rebuild, and the legacy-mission adapter.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// Hermetic: point the advisory event rail at a dead port.
process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';

const FAKE_DB = new FakeDb();
const ALL_COLLECTIONS = ['mission_states', 'mission_state_versions', 'epistemic_entries', 'state_deltas', 'cognitive_batons', 'mission_events', 'memory_missions'];

import { MissionStateService } from '../../src/services/mission-cognition/mission-state-service.js';
import { StateDeltaService } from '../../src/services/mission-cognition/state-delta-service.js';
import { EpistemicLedgerService } from '../../src/services/mission-cognition/epistemic-ledger-service.js';
import { BatonService, assertNoSecretMaterial } from '../../src/services/mission-cognition/baton-service.js';
import { adaptLegacyMission, adoptLegacyMission } from '../../src/services/mission-cognition/adapter.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';
import type { LedgerEntryDraft, MissionState, StateDeltaDraft } from '../../src/types/cognitive-control.js';

const db = FAKE_DB.asDb();
const missions = new MissionStateService(db);
const deltas = new StateDeltaService(db);
const ledger = new EpistemicLedgerService(db);
const batons = new BatonService(db);

function baseMission(overrides: Partial<MissionState> = {}): MissionState {
  return {
    schema_version: '1.0',
    mission_id: 'test_mission_1',
    version: 1,
    title: 'Test Mission',
    intent: 'Prove continuity invariants.',
    status: 'active',
    owner_id: 'satori',
    success_criteria: [{ id: 'c1', description: 'invariants hold', status: 'unmet' }],
    authority_class: 'B',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function claimDelta(base: number, idemKey: string, statement: string, extra: Partial<StateDeltaDraft> = {}): StateDeltaDraft {
  const entry: LedgerEntryDraft = {
    schema_version: '1.0',
    mission_id: 'test_mission_1',
    entry_type: 'claim',
    statement,
    status: 'accepted',
    author_id: 'satori',
    confidence: 0.6,
  };
  return {
    schema_version: '1.0',
    idempotency_key: idemKey,
    mission_id: 'test_mission_1',
    base_mission_version: base,
    author_id: 'satori',
    delta_type: 'CLAIM_ADDED',
    operations: [{ op: 'add', path: '/ledger_refs/-', value: statement.slice(0, 12) }],
    ledger_entries: [entry],
    rationale: 'unit test',
    confidence: 0.6,
    ...extra,
  };
}

beforeAll(() => { FAKE_DB.reset(); });
afterEach(() => FAKE_DB.reset());

describe('schema registry', () => {
  it('accepts a valid mission state and rejects missing required fields', () => {
    expect(validateAgainst(SCHEMA_IDS.missionState, baseMission()).valid).toBe(true);
    const bad = baseMission() as any; delete bad.title;
    const res = validateAgainst(SCHEMA_IDS.missionState, bad);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/title/);
  });
  it('tolerates additive minor fields (additionalProperties relaxed at root)', () => {
    const withMinor = { ...baseMission(), future_field_added_in_minor: { x: 1 } };
    expect(validateAgainst(SCHEMA_IDS.missionState, withMinor).valid).toBe(true);
  });
  it('keeps append-only audit contracts strict (plan §3.3 split)', () => {
    const delta = {
      schema_version: '1.0', delta_id: 'd1', idempotency_key: 'idem-key-x1', mission_id: 'm',
      base_mission_version: 1, author_id: 'satori', delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/x', value: 1 }], rationale: 'r', confidence: 0.5,
      created_at: new Date().toISOString(),
    };
    expect(validateAgainst(SCHEMA_IDS.stateDelta, delta).valid).toBe(true);
    // implementation fields are part of the contract (minor additive)
    expect(validateAgainst(SCHEMA_IDS.stateDelta, { ...delta, status: 'accepted', applied_at: new Date().toISOString() }).valid).toBe(true);
    // unknown minor field is rejected: strictness is a feature for audit records
    expect(validateAgainst(SCHEMA_IDS.stateDelta, { ...delta, unknown_minor_field: 1 }).valid).toBe(false);
    const entry = {
      schema_version: '1.0', entry_id: 'e1', mission_id: 'm', entry_type: 'claim',
      statement: 's', status: 'accepted', author_id: 'a', confidence: 0.5,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    expect(validateAgainst(SCHEMA_IDS.epistemicEntry, entry).valid).toBe(true);
    expect(validateAgainst(SCHEMA_IDS.epistemicEntry, { ...entry, unknown_minor_field: 1 }).valid).toBe(false);
  });
});

describe('mission state + state deltas', () => {
  it('advances versions monotonically and applies a delta exactly once (idempotency)', async () => {
    await missions.createMissionState(baseMission());
    const d1 = await deltas.submitDelta(claimDelta(1, 'idem-key-1', 'The sky is blue.'), { actorId: 'satori' });
    expect(d1.status).toBe('accepted');
    const s2 = await missions.getMissionState('test_mission_1');
    expect(s2!.version).toBe(2);
    // exact-once: same idempotency key returns the original accepted result
    const dup = await deltas.submitDelta(claimDelta(1, 'idem-key-1', 'The sky is blue.'), { actorId: 'satori' });
    expect(dup.status).toBe('accepted');
    expect(dup.delta_id).toBe(d1.delta_id);
    const sAgain = await missions.getMissionState('test_mission_1');
    expect(sAgain!.version).toBe(2); // no double apply
  });
  it('routes a stale-base delta to conflict and drops neither proposal', async () => {
    await missions.createMissionState(baseMission());
    await deltas.submitDelta(claimDelta(1, 'idem-key-a', 'claim A'), { actorId: 'satori' });
    const stale = await deltas.submitDelta(claimDelta(1, 'idem-key-b', 'claim B (stale base)'), { actorId: 'satori' });
    expect(stale.status).toBe('conflict');
    const all = await deltas.listDeltas('test_mission_1');
    expect(all.length).toBe(2); // both recorded, neither dropped
  });
  it('binds authorship to the caller, not the payload', async () => {
    await missions.createMissionState(baseMission());
    const forged = claimDelta(1, 'idem-key-forge', 'claim', { author_id: 'someone_else' });
    const d = await deltas.submitDelta(forged, { actorId: 'real_caller' });
    expect(d.author_id).toBe('real_caller');
  });
});

describe('epistemic ledger', () => {
  it('never overwrites confidence — history records prior/next/reason/actor', async () => {
    const e = await ledger.appendEntry({
      schema_version: '1.0', mission_id: 'test_mission_1', entry_type: 'assumption',
      statement: 'Network egress is reliable.', status: 'accepted', author_id: 'satori', confidence: 0.5,
    });
    const updated = await ledger.updateConfidence(e.entry_id, 0.8, 'observed 429s', 'satori');
    expect(updated!.confidence).toBe(0.8);
    expect(updated!.confidence_history).toHaveLength(1);
    expect(updated!.confidence_history![0]).toMatchObject({ prior: 0.5, next: 0.8, reason: 'observed 429s', actor_id: 'satori' });
  });
  it('terminates dependency traversal even with cycles', async () => {
    const a = await ledger.appendEntry({ schema_version: '1.0', mission_id: 'test_mission_1', entry_type: 'claim', statement: 'a', status: 'accepted', author_id: 'satori', confidence: 0.5, depends_on: ['id-b'] });
    await ledger.appendEntry({ schema_version: '1.0', mission_id: 'test_mission_1', entry_id: 'id-b', entry_type: 'claim', statement: 'b', status: 'accepted', author_id: 'satori', confidence: 0.5, depends_on: [a.entry_id] });
    const closure = await ledger.dependencyClosure(a.entry_id);
    expect(closure.entry_ids).toContain('id-b');
    expect(closure.cycle).toBe(true);
  });
});

describe('cognitive baton', () => {
  it('blind batons withhold incumbent decision/claim material', async () => {
    await missions.createMissionState(baseMission());
    const dec = await ledger.appendEntry({ schema_version: '1.0', mission_id: 'test_mission_1', entry_type: 'decision', statement: 'We chose design X.', status: 'accepted', author_id: 'satori', confidence: 0.9 });
    const ev = await ledger.appendEntry({ schema_version: '1.0', mission_id: 'test_mission_1', entry_type: 'evidence', statement: 'Benchmark shows 2x throughput.', status: 'accepted', author_id: 'satori', confidence: 0.8 });
    await db.collection('mission_states').updateOne({ mission_id: 'test_mission_1' }, { $set: { ledger_refs: [dec.entry_id, ev.entry_id] } });
    const blind = await batons.compileBaton({
      schema_version: '1.0', mission_id: 'test_mission_1', mission_version: 1, recipient_id: 'worker-1',
      mode: 'challenge', objective: 'Re-evaluate.', deliverable: 'delta',
      blindness: { enabled: true, withheld_classes: ['incumbent_conclusion', 'incumbent_rationale'] },
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    });
    const text = JSON.stringify(blind.context);
    expect(text).toContain('Benchmark shows');
    expect(text).not.toContain('design X');
    expect(blind.mission_version).toBe(1);
  });
  it('rejects secret-bearing material at serialization', () => {
    expect(() => assertNoSecretMaterial('x=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toThrow(/secret/);
    expect(() => assertNoSecretMaterial('capability_id: github.kolega.write')).not.toThrow();
  });
  it('revokes stale batons when the mission version advances', async () => {
    await missions.createMissionState(baseMission());
    await deltas.submitDelta(claimDelta(1, 'idem-key-c', 'claim'), { actorId: 'satori' }); // -> v2
    const b = await batons.issueBaton({
      schema_version: '1.0', mission_id: 'test_mission_1', mission_version: 2, recipient_id: 'worker-1',
      mode: 'execute', objective: 'Do work.', deliverable: 'delta',
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    });
    expect(await batons.getBaton(b.baton_id)).not.toBeNull();
    await deltas.submitDelta(claimDelta(2, 'idem-key-d', 'another claim'), { actorId: 'satori' }); // -> v3
    expect(await batons.getBaton(b.baton_id)).toBeNull(); // revoked, not silently overwritable
  });
});

describe('checkpoint + deterministic rebuild', () => {
  it('rebuilds state from checkpoint + accepted deltas', async () => {
    await missions.createMissionState(baseMission());
    await deltas.submitDelta(claimDelta(1, 'idem-key-e', 'e'), { actorId: 'satori' }); // v2
    await missions.checkpointMission('test_mission_1', 'satori'); // checkpoint v2
    await deltas.submitDelta(claimDelta(2, 'idem-key-f', 'f'), { actorId: 'satori' }); // v3
    await deltas.submitDelta(claimDelta(3, 'idem-key-g', 'g'), { actorId: 'satori' }); // v4
    const current = await missions.getMissionState('test_mission_1');
    const rebuilt = await missions.rebuildFromCheckpoint('test_mission_1');
    expect(rebuilt!.version).toBe(current!.version);
    expect(rebuilt!.ledger_refs).toEqual(current!.ledger_refs);
  });
});

describe('legacy mission adapter', () => {
  it('maps a legacy mission to a v1 mission state and is idempotent', async () => {
    FAKE_DB.collection('memory_missions').docs.push({
      _id: 'legacy_1', user_id: 'johnpellew', status: 'ACTIVE', meta_goal: 'Ship the thing',
      task_tree: [
        { id: 't1', description: 'Plan', status: 'IN_PROGRESS' },
        { id: 't2', description: 'Build', status: 'PENDING' },
      ],
      created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-02T00:00:00Z'),
    });
    const adopted = await adoptLegacyMission(db, 'legacy_1');
    expect(adopted.mission_id).toBe('legacy_1');
    expect(adopted.version).toBe(1);
    expect(adopted.status).toBe('active');
    expect(adopted.authority_class).toBe('B');
    expect(adopted.objectives).toHaveLength(2);
    expect(adopted.objectives![0]).toMatchObject({ id: 't1', status: 'in_progress', owner_id: 'johnpellew' });
    expect(adopted.success_criteria![0].description).toBe('Ship the thing');
    const again = await adoptLegacyMission(db, 'legacy_1');
    expect(again.version).toBe(1); // no second copy
    const pure = adaptLegacyMission({ _id: 'x', status: 'ABANDONED' });
    expect(pure.status).toBe('cancelled');
  });
});
