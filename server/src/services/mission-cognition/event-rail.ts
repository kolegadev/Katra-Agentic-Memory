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
        // Advisory rail: fail fast, never hang the durable path. No reconnect —
        // if Redis is down at first use we return null and retry on a later event
        // (harness defect #1: reconnectStrategy:3000 made connect() wait forever
        // against a dead port, wedging every process that emits an event).
        const client = createClient({
          url,
          socket: { connectTimeout: 3000, reconnectStrategy: false },
        });
        client.on('error', () => { /* advisory rail: never crash the durable path */ });
        await client.connect();
        return { publish: (msg: string) => client.publish(REDIS_EVENT_CHANNEL, msg).then(() => undefined) };
      } catch {
        _publisherPromise = null; // retry lazily on the next event
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
