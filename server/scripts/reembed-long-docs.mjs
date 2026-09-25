#!/usr/bin/env node
/**
 * Backfill: re-embed long documents with windowed encoding (2026-09-25).
 *
 * Documents longer than the model's 512 positions used to be truncated and
 * mean-pooled once, so everything past the first window was invisible to
 * vector search. New embeddings are windowed (see embedding-service.ts); this
 * script refreshes documents that were embedded BEFORE that change.
 *
 * Selection is resumable: a document is only processed while it lacks
 * `embedding_windows`, so re-running continues where the last run stopped.
 *
 * Usage (the runtime image keeps only the compiled build, so copy it in):
 *   docker cp server/scripts/reembed-long-docs.mjs katra-server:/tmp/
 *   docker exec katra-server node /tmp/reembed-long-docs.mjs --dry-run
 *   docker exec katra-server node /tmp/reembed-long-docs.mjs --limit 400
 *
 * Flags: --min-chars N (default 1600) --limit N (default 0 = all)
 *        --collection NAME (default semantic_facts) --dry-run --verbose
 */

import { pathToFileURL } from 'node:url';

const BUILD = process.env.KATRA_BUILD_DIR || '/app/build';

function parseArgs(argv) {
  const flags = { 'min-chars': 1600, limit: 0, collection: 'semantic_facts', 'dry-run': false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (name === 'dry-run' || name === 'verbose') {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value !== undefined) flags[name] = Number.isNaN(Number(value)) ? value : Number(value);
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);
  const load = (rel) => import(pathToFileURL(`${BUILD}/${rel}`).href);

  const { connect_to_mongodb, get_database, close_connection } = await load('database/connection.js');
  const { embeddingService } = await load('services/infrastructure/embedding-service.js');

  await connect_to_mongodb();
  const db = get_database();
  const coll = db.collection(flags.collection);

  const filter = {
    embedding: { $exists: true },
    embedding_windows: { $exists: false },
    $expr: { $gt: [{ $strLenCP: '$content' }, flags['min-chars']] },
  };

  const total = await coll.countDocuments(filter);
  console.log(`long documents needing windowed embeddings: ${total} (min ${flags['min-chars']} chars)`);
  if (flags['dry-run']) {
    const sample = await coll.find(filter, { projection: { content: 1 } }).limit(5).toArray();
    for (const doc of sample) {
      const windows = embeddingService.splitForEmbedding(doc.content || '');
      console.log(`  ${(doc.content || '').length} chars -> ${windows.length} windows`);
    }
    await close_connection();
    return;
  }

  const limit = flags.limit > 0 ? flags.limit : total;
  const cursor = coll.find(filter, { projection: { content: 1, embedding: 1 } }).limit(limit);

  let done = 0;
  let skipped = 0;
  let firstDelta = null;

  for await (const doc of cursor) {
    const content = doc.content || '';
    const windows = embeddingService.splitForEmbedding(content);
    const vector = await embeddingService.encode(content);
    if (!vector) {
      skipped++;
      continue;
    }
    if (firstDelta === null && Array.isArray(doc.embedding) && doc.embedding.length === vector.length) {
      firstDelta = embeddingService.cosineSimilarity(doc.embedding, vector);
    }
    await coll.updateOne(
      { _id: doc._id },
      {
        $set: {
          embedding: vector,
          embedding_model: embeddingService.modelName,
          embedding_version: embeddingService.version,
          has_embedding: true,
          embedding_windows: windows.length,
          embedding_chars: content.length,
        },
      },
    );
    done++;
    if (flags.verbose || done % 25 === 0) {
      console.log(`  re-embedded ${done}/${limit} (${windows.length} windows, ${content.length} chars)`);
    }
  }

  console.log(`done: ${done} re-embedded, ${skipped} skipped, ${limit - done - skipped} not reached`);
  if (firstDelta !== null) {
    console.log(`sanity: first document's old vs new vector cosine = ${firstDelta.toFixed(3)} (identical vectors would be 1.000)`);
  }
  await close_connection();
}

main().catch(error => {
  console.error('backfill failed:', error?.message || error);
  process.exit(1);
});
