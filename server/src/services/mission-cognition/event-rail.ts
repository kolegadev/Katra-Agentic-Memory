// Durable mission event outbox + best-effort pub/sub emission.
// Review §3.5: the existing Redis rail is a consolidation output bus, so the
// durable record is Mongo (mission_events) and Redis publish is advisory.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS, EVENT_TTL_SECONDS } from './collections.js';
import type { MissionEvent } from '../../types/cognitive-control.js';

const REDIS_EVENT_CHANNEL = 'katra:mission-events';

export async function emitMissionEvent(
  db: Db,
  event: Omit<MissionEvent, 'event_id' | 'created_at'>,
): Promise<MissionEvent> {
  const full: MissionEvent = {
    ...event,
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  await db.collection(COLLECTIONS.missionEvents).insertOne({
    ...full,
    _expires_at: new Date(Date.now() + EVENT_TTL_SECONDS * 1000),
  });
  // Advisory publish — never throws, never blocks durable state.
  publishBestEffort(full).catch(() => {});
  return full;
}

async function publishBestEffort(event: MissionEvent): Promise<void> {
  try {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const { createClient } = await import('redis');
    const client = createClient({ url });
    await client.connect();
    await client.publish(REDIS_EVENT_CHANNEL, JSON.stringify(event));
    await client.quit();
  } catch {
    // Redis unavailable — the outbox record already persists the event.
  }
}
