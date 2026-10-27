/**
 * Mission trigger sweep + the ninth detector (2026-10-23).
 *
 * The point of these tests is the failure that actually happened: a mission can
 * sit untouched for a month while its state says `active`, and none of the eight
 * epistemic detectors can see it because they are predicates over ledger
 * content. `mission_stalled` is the detector that looks at time.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { evaluateTriggers } from '../../src/services/mission-cognition/uncertainty-triggers.js';
import { sweepActiveMissions } from '../../src/services/mission-cognition/mission-trigger-sweep.js';

const FAKE_DB = new FakeDb();
const db = FAKE_DB.asDb();

const NOW = Date.parse('2026-10-23T20:00:00.000Z');
const DAY = 86400000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function seedMission(id: string, overrides: Record<string, any> = {}): void {
  FAKE_DB.collection('mission_states').docs.push({
    schema_version: '1.0',
    mission_id: id,
    version: 3,
    title: id,
    intent: 'test',
    status: 'active',
    owner_id: 'agent-a',
    success_criteria: [],
    authority_class: 'B',
    created_at: ago(40),
    updated_at: ago(30),
    ...overrides,
  });
}

function seedDelta(missionId: string, daysAgo: number, status = 'accepted'): void {
  FAKE_DB.collection('state_deltas').docs.push({
    delta_id: `d_${missionId}_${daysAgo}`,
    mission_id: missionId,
    status,
    created_at: ago(daysAgo),
    applied_at: status === 'accepted' ? ago(daysAgo) : undefined,
  });
}

const stalls = async (id: string) => {
  const { fired, byTrigger } = await evaluateTriggers(db, id, { now: NOW });
  return { stalled: byTrigger['mission_stalled'] ?? 0, all: fired };
};

afterEach(() => {
  FAKE_DB.reset();
  delete process.env.MISSION_STALL_DAYS;
});

describe('mission_stalled — the ninth detector', () => {
  it('fires on an active mission whose last accepted delta is older than the threshold', async () => {
    seedMission('m_old');
    seedDelta('m_old', 30);
    const { stalled, all } = await stalls('m_old');
    expect(stalled).toBe(1);
    const hit = all.find(f => f.trigger === 'mission_stalled');
    expect(hit?.reason).toContain('last accepted delta 30 days ago');
  });

  it('does not fire on a mission that moved recently', async () => {
    seedMission('m_moving');
    seedDelta('m_moving', 1);
    expect((await stalls('m_moving')).stalled).toBe(0);
  });

  it('does not fire on a completed mission however old it is', async () => {
    seedMission('m_done', { status: 'completed' });
    seedDelta('m_done', 40);
    expect((await stalls('m_done')).stalled).toBe(0);
  });

  it('measures a never-moved mission from its creation, so a fresh one is not stalled', async () => {
    seedMission('m_new', { created_at: ago(1) });
    seedMission('m_abandoned', { created_at: ago(40) });
    expect((await stalls('m_new')).stalled).toBe(0);
    const { all } = await stalls('m_abandoned');
    expect(all.find(f => f.trigger === 'mission_stalled')?.reason).toContain('no accepted delta since creation');
  });

  it('ignores rejected deltas: only accepted state counts as movement', async () => {
    seedMission('m_rejected');
    seedDelta('m_rejected', 1, 'rejected');
    seedDelta('m_rejected', 40);
    // The recent delta was rejected, so the last *accepted* movement is 40 days back.
    expect((await stalls('m_rejected')).stalled).toBe(1);
  });

  it('honours MISSION_STALL_DAYS', async () => {
    seedMission('m_threshold');
    seedDelta('m_threshold', 30);
    expect((await stalls('m_threshold')).stalled).toBe(1);
    process.env.MISSION_STALL_DAYS = '60';
    expect((await stalls('m_threshold')).stalled).toBe(0);
  });

  it('is a function of state and clock, not of when it is called', async () => {
    seedMission('m_det');
    seedDelta('m_det', 20);
    const a = await evaluateTriggers(db, 'm_det', { now: NOW });
    const b = await evaluateTriggers(db, 'm_det', { now: NOW });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('does not fire when there is no mission state at all (existing call sites stay green)', async () => {
    expect((await stalls('m_absent')).stalled).toBe(0);
  });
});

describe('sweep over the portfolio', () => {
  it('scans active missions only and reports the stalled ones by id', async () => {
    seedMission('m_old');
    seedDelta('m_old', 30);
    seedMission('m_moving');
    seedDelta('m_moving', 1);
    seedMission('m_never', { created_at: ago(40) });
    seedMission('m_done', { status: 'completed' });
    seedDelta('m_done', 40);

    const sweep = await sweepActiveMissions(db, { now: NOW, persist: false });
    expect(sweep.missions_scanned).toBe(3); // the completed one is not scanned
    expect(sweep.stalled.sort()).toEqual(['m_never', 'm_old']);
    expect(sweep.errors).toEqual([]);
    expect(
      sweep.missions.find(m => m.mission_id === 'm_moving')?.by_trigger['mission_stalled'],
    ).toBe(0);
  });

  it('persists exactly one append-only record per sweep', async () => {
    seedMission('m_old');
    seedDelta('m_old', 30);
    const sweep = await sweepActiveMissions(db, { now: NOW });
    const stored = FAKE_DB.collection('trigger_sweeps').docs;
    expect(stored).toHaveLength(1);
    expect(stored[0].sweep_id).toBe(sweep.sweep_id);
    expect(stored[0].stalled).toEqual(['m_old']);
    expect(stored[0].stall_days).toBe(14);
  });

  it('writes no mission state and no epistemic entry', async () => {
    seedMission('m_old');
    seedDelta('m_old', 30);
    const before = JSON.stringify(FAKE_DB.collection('mission_states').docs);
    const deltasBefore = JSON.stringify(FAKE_DB.collection('state_deltas').docs);
    await sweepActiveMissions(db, { now: NOW });
    expect(JSON.stringify(FAKE_DB.collection('mission_states').docs)).toBe(before);
    expect(JSON.stringify(FAKE_DB.collection('state_deltas').docs)).toBe(deltasBefore);
    expect(FAKE_DB.collection('epistemic_entries').docs).toHaveLength(0);
  });

  it('an empty portfolio is a valid sweep, not an error', async () => {
    const sweep = await sweepActiveMissions(db, { now: NOW, persist: false });
    expect(sweep.missions_scanned).toBe(0);
    expect(sweep.stalled).toEqual([]);
  });
});
