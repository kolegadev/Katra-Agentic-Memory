#!/usr/bin/env node
/**
 * One-off embedding backfill for semantic_facts.
 *
 * Runs INSIDE the katra-server container so it reuses the exact same
 * embedding model/settings as live processing (vector parity) and can reach
 * mongo on the docker network.
 *
 * - Only touches facts with no `embedding` field (idempotent / resumable).
 * - Threshold: content length >= MIN_LEN (default 100, matching new policy).
 * - Batched with a short pause to avoid pegging CPU.
 *
 * Env:
 *   MIN_LEN=100         minimum content length to embed
 *   BATCH=200           facts per batch
 *   USER_ID=            optional: restrict to one user_id
 *   MAX=0               optional cap for a dry/smoke run (0 = all)
 */
import { MongoClient } from 'mongodb';
import { embeddingService } from '/app/build/services/infrastructure/embedding-service.js';

const URI = process.env.MONGODB_URI;
const MIN_LEN = parseInt(process.env.MIN_LEN || '100', 10);
const BATCH = parseInt(process.env.BATCH || '200', 10);
const USER_ID = process.env.USER_ID || '';
const MAX = parseInt(process.env.MAX || '0', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db('katra');
  const col = db.collection('semantic_facts');

  const filter = {
    embedding: { $exists: false },
    $expr: { $gte: [{ $strLenCP: { $ifNull: ['$content', ''] } }, MIN_LEN] },
  };
  if (USER_ID) filter.user_id = USER_ID;

  const total = await col.countDocuments(filter);
  console.log(`[backfill] eligible facts (no embedding, >=${MIN_LEN} chars${USER_ID ? `, user=${USER_ID}` : ''}): ${total}`);
  if (total === 0) { await client.close(); return; }

  // Warm the model once.
  const warm = await embeddingService.encode('warmup embedding backfill initialization sentence for the model loader');
  console.log(`[backfill] model ready: ${embeddingService.isReady} (warmup vec: ${warm ? warm.length + 'd' : 'null'})`);
  if (!embeddingService.isReady) { console.error('[backfill] ABORT: embedding model not ready'); await client.close(); process.exit(2); }

  let embedded = 0, skipped = 0, processed = 0;
  const started = Date.now();

  while (true) {
    if (MAX && processed >= MAX) break;
    const docs = await col.find(filter).limit(BATCH).toArray();
    if (docs.length === 0) break;

    for (const d of docs) {
      processed++;
      const vec = await embeddingService.encode(d.content, 'semantic_fact');
      if (vec) {
        await col.updateOne(
          { _id: d._id },
          { $set: { embedding: vec, embedding_model: embeddingService.modelName, embedding_version: embeddingService.version } }
        );
        embedded++;
      } else {
        // shouldn't happen (we pre-filtered by length) but guard against SKIP_PATTERNS:
        // mark with a sentinel so the query doesn't loop forever on it.
        await col.updateOne(
          { _id: d._id },
          { $set: { embedding_skipped: true, embedding_skipped_reason: 'quality_filter' } }
        );
        skipped++;
      }
      if (MAX && processed >= MAX) break;
    }

    // exclude sentinel-skipped from the next query pass
    filter.embedding_skipped = { $ne: true };

    const rate = (embedded / ((Date.now() - started) / 1000)).toFixed(1);
    console.log(`[backfill] progress: ${embedded} embedded, ${skipped} skipped, ~${rate}/s`);
    await sleep(250); // breathe between batches
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[backfill] DONE: ${embedded} embedded, ${skipped} skipped, ${processed} processed in ${secs}s`);
  await client.close();
}

main().catch((e) => { console.error('[backfill] FATAL:', e); process.exit(1); });
