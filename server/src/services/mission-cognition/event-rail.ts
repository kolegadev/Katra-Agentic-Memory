// Durable mission event outbox + best-effort pub/sub emission.
// Review §3.5: the existing Redis rail is a consolidation output bus, so the
// durable record is Mongo (mission_events) and Redis publish is advisory.
// The Redis client is a single lazily-created process-lifetime connection
// (Lilly review note 2026-09-19: per-event connect/publish/quit churn removed).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS, EVENT_TTL_SECONDS } from './collections.js';
import type { MissionEvent } from '../../types/cognitive-control.js';

const REDIS_EVENT_CHANNEL = 'katra:mission-events';

let _publisherPromise: Promise<{ publish: (msg: string) => Promise<void> } | null> | null = null;

/** One lazily-created publisher for the process lifetime; null when Redis is unavailable. */
function getPublisher(): Promise<{ publish: (msg: string) => Promise<void> } | null> {
  if (_publisherPromise === null) {
    _publisherPromise = (async () => {
      try {
        const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
        const { createClient } = await import('redis');
        const client = createClient({ url, socket: { reconnectStrategy: 3000 } });
        client.on('error', () => { /* advisory rail: never crash the durable path */ });
        await client.connect();
        return { publish: (msg: string) => client.publish(REDIS_EVENT_CHANNEL, msg).then(() => undefined) };
      } catch {
        return null; // Redis unavailable — the outbox record already persists the event
      }
    })();
  }
  return _publisherPromise;
}

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
  publishBestEffort(full);
  return full;
}

async function publishBestEffort(event: MissionEvent): Promise<void> {
  try {
    const publisher = await getPublisher();
    await publisher?.publish(JSON.stringify(event));
  } catch {
    // advisory only
  }
}
