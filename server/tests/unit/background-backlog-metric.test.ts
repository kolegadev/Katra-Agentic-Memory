/**
 * Unit tests — the background-processor backlog metric must not saturate.
 *
 * Regression cover for a monitoring blind spot: getProcessingStats() fetched up
 * to 1,000 documents purely to read `.length`, so it reported
 * min(backlog, 1000) — the metric went blind exactly when the backlog was worst.
 * Measured against the live database before the fix: a true backlog of 3,389
 * surfaced as 1,000, a 3.39x under-report.
 *
 * The same method also claimed more than it did: forceProcessAll() processed ONE
 * batch of 1,000 and returned success, so above 1,000 "all" was silently false.
 *
 * What this file pins: the count is uncapped, the count and the fetch share one
 * filter (so they cannot drift), and a backlog above the old cap is reported
 * truthfully.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, vi } from 'vitest';

// Hermetic: point the advisory event rail at a dead port.
process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';

const FAKE_DB = new FakeDb();

import { MemoryManager, UNPROCESSED_EVENTS_FILTER } from '../../src/services/memory/memory-manager.js';
import { BackgroundProcessor } from '../../src/services/processing/background-processor.js';

const OLD_CAP = 1000;

function seedEvent(i: number, opts: { processed?: boolean; terminal?: boolean; noSession?: boolean } = {}) {
  const doc: Record<string, any> = {
    id: `ev_${i}`,
    user_id: 'operator',
    session_id: opts.noSession ? undefined : `s_${i}`,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    content: { message: `event ${i}` },
    metadata: {
      ...(opts.processed ? { processed: true } : {}),
      ...(opts.terminal ? { terminal_failure: true } : {}),
    },
  };
  FAKE_DB.collection('episodic_events').docs.push(doc);
}

async function fresh(): Promise<{ mem: MemoryManager; proc: BackgroundProcessor }> {
  FAKE_DB.reset();
  // Reset the singletons' view: they are process-wide, but FAKE_DB is swapped by
  // the mock, so re-fetching the instance is enough for these tests.
  return { mem: MemoryManager.get_instance(), proc: BackgroundProcessor.get_instance() };
}

describe('backlog metric does not saturate', () => {
  it('reports a backlog ABOVE the old cap truthfully (the defect this guards)', async () => {
    const { mem, proc } = await fresh();

    const UNPROCESSED = 1500; // deliberately above the old 1000 cap
    for (let i = 0; i < UNPROCESSED; i++) seedEvent(i);
    for (let i = 0; i < 40; i++) seedEvent(10000 + i, { processed: true }); // already done
    for (let i = 0; i < 25; i++) seedEvent(20000 + i, { terminal: true }); // terminally failed
    for (let i = 0; i < 7; i++) seedEvent(30000 + i, { noSession: true }); // unprocessable

    const counted = await mem.count_unprocessed_events();

    // The old implementation's exact formula, for contrast.
    const oldStyle =
      (await mem.get_unprocessed_events(1)).length > 0
        ? (await mem.get_unprocessed_events(OLD_CAP)).length
        : 0;

    expect(counted).toBe(UNPROCESSED);
    expect(oldStyle).toBe(OLD_CAP); // pinned at the cap — the bug, demonstrated
    expect(counted).toBeGreaterThan(oldStyle);

    // And the stats surface a monitor actually reads.
    const stats = await proc.getProcessingStats();
    expect(stats.unprocessed_count).toBe(UNPROCESSED);
  });

  it('still reports small backlogs exactly, and zero when there is nothing to do', async () => {
    const { mem, proc } = await fresh();
    expect(await mem.count_unprocessed_events()).toBe(0);
    expect((await proc.getProcessingStats()).unprocessed_count).toBe(0);

    for (let i = 0; i < 3; i++) seedEvent(i);
    expect(await mem.count_unprocessed_events()).toBe(3);
    expect((await proc.getProcessingStats()).unprocessed_count).toBe(3);
  });

  it('the count and the fetch share ONE filter, so they cannot drift apart', async () => {
    const { mem } = await fresh();
    // Seed a mix and assert the count equals the number of events the fetch
    // would actually return when uncapped. If someone later edits only one of
    // the two call sites, this equality breaks.
    for (let i = 0; i < 12; i++) seedEvent(i);
    for (let i = 0; i < 5; i++) seedEvent(5000 + i, { processed: true });
    for (let i = 0; i < 4; i++) seedEvent(6000 + i, { noSession: true });

    const counted = await mem.count_unprocessed_events();
    const fetched = (await mem.get_unprocessed_events(1e6)).length;
    expect(counted).toBe(fetched);
    expect(counted).toBe(12);

    // The filter is exported and used by the count.
    expect(Object.keys(UNPROCESSED_EVENTS_FILTER)).toContain('metadata.processed');
    expect(Object.keys(UNPROCESSED_EVENTS_FILTER)).toContain('session_id');
  });

  it('excludes processed, terminally failed, and unprocessable events from the count', async () => {
    const { mem } = await fresh();
    for (let i = 0; i < 6; i++) seedEvent(i);
    for (let i = 0; i < 3; i++) seedEvent(100 + i, { processed: true });
    for (let i = 0; i < 2; i++) seedEvent(200 + i, { terminal: true });
    for (let i = 0; i < 5; i++) seedEvent(300 + i, { noSession: true });

    expect(await mem.count_unprocessed_events()).toBe(6);
  });
});
