#!/usr/bin/env node
/**
 * One-off embedding backfill for episodic_events.
 *
 * Mirrors the live embedding policy:
 *  - skips system-noise event types (heartbeat/task_execution/etc.)
 *  - embeddable text = content.message || content.description || (content if string)
 *  - only text length >= MIN_LEN (default 100)
 *  - only events with no existing `embedding`
 * Idempotent / resumable. Runs inside katra-server container for vector parity.
 *
 * Env: MIN_LEN=100  BATCH=200  MAX=0
 */
import { MongoClient } from 'mongodb';
import { embeddingService } from '/app/build/services/infrastructure/embedding-service.js';

const URI = process.env.MONGODB_URI;
const MIN_LEN = parseInt(process.env.MIN_LEN || '100', 10);
const BATCH = parseInt(process.env.BATCH || '200', 10);
const MAX = parseInt(process.env.MAX || '0', 10);

const SYSTEM_TYPES = new Set([
  'heartbeat_action', 'task_execution', 'autonomous_action',
  'system_update', 'agent_bulletin', 'system_message',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.message === 'string') return content.message;
    if (typeof content.description === 'string') return content.description;
  }
  return '';
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const col = client.db('katra').collection('episodic_events');

  // Mongo-side coarse filter: no embedding + not system type.
  // Fine-grained text-length check happens in JS (handles the message/description/string variants).
  const filter = {
    embedding: { $exists: false },
    embedding_skipped: { $ne: true },
    event_type: { $nin: [...SYSTEM_TYPES] },
  };

  const candidates = await col.countDocuments(filter);
  console.log(`[epi-backfill] non-system candidates without embedding: ${candidates} (will embed text >= ${MIN_LEN} chars)`);

  const warm = await embeddingService.encode('warmup episodic embedding backfill initialization sentence for loader');
  console.log(`[epi-backfill] model ready: ${embeddingService.isReady} (warmup: ${warm ? warm.length + 'd' : 'null'})`);
  if (!embeddingService.isReady) { console.error('[epi-backfill] ABORT: model not ready'); await client.close(); process.exit(2); }

  let embedded = 0, skippedShort = 0, processed = 0;
  const started = Date.now();

  while (true) {
    if (MAX && processed >= MAX) break;
    const docs = await col.find(filter).limit(BATCH).toArray();
    if (docs.length === 0) break;

    for (const d of docs) {
      processed++;
      const text = extractText(d.content);
      if (!text || text.length < MIN_LEN) {
        // Below policy threshold — mark so we don't re-scan it forever.
        await col.updateOne({ _id: d._id }, { $set: { embedding_skipped: true, embedding_skipped_reason: `below_min_len_${MIN_LEN}` } });
        skippedShort++;
      } else {
        const vec = await embeddingService.encode(text, d.event_type);
        if (vec) {
          await col.updateOne({ _id: d._id }, { $set: { embedding: vec, embedding_model: embeddingService.modelName, embedding_version: embeddingService.version } });
          embedded++;
        } else {
          await col.updateOne({ _id: d._id }, { $set: { embedding_skipped: true, embedding_skipped_reason: 'quality_filter' } });
          skippedShort++;
        }
      }
      if (MAX && processed >= MAX) break;
    }

    const rate = (embedded / ((Date.now() - started) / 1000)).toFixed(1);
    console.log(`[epi-backfill] progress: ${embedded} embedded, ${skippedShort} skipped-short, ${processed} scanned, ~${rate}/s`);
    await sleep(250);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[epi-backfill] DONE: ${embedded} embedded, ${skippedShort} skipped-short, ${processed} scanned in ${secs}s`);
  await client.close();
}

main().catch((e) => { console.error('[epi-backfill] FATAL:', e); process.exit(1); });
