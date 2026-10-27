// Episodic compaction — collapse near-duplicate distilled events by proposition.
// the loop director, 2026-10-21. Default is a DRY RUN; pass --apply to write.
//
//   node /app/compact-episodic.mjs            # report only
//   node /app/compact-episodic.mjs --apply    # export + merge + delete
//
// Export is finished BEFORE any delete, gzipped JSONL, one line per removed
// document, then verified line-count == delete-count.

import { MongoClient } from 'mongodb';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { normalizeProposition, episodicPropositionKey } from './proposition-key.mjs';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB = process.env.DATABASE_NAME || 'katra';
const EXPORT_DIR = process.env.EXPORT_DIR || '/app/exports';
mkdirSync(EXPORT_DIR, { recursive: true });
const OUT = join(EXPORT_DIR, `episodic-merged-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`);

// ── must match server/src/services/memory/proposition-key.ts ────────────────
const RAW_EVENT_TYPES = new Set([
  'conversation', 'agent_message', 'user_communication', 'machine_health',
  'gas_law_watcher_cycle', 'heartbeat_action', 'executive_action', 'action',
  'tool_call', 'system',
]);

function descriptionOf(content) {
  if (!content) return null;
  if (typeof content === 'string') return content.trim() || null;
  if (typeof content !== 'object') return null;
  for (const f of ['description', 'summary', 'message']) {
    if (typeof content[f] === 'string' && content[f].trim()) return content[f].trim();
  }
  return null;
}

const client = new MongoClient(URI);
await client.connect();
const db = client.db(DB);
const coll = db.collection('episodic_events');

const docsBefore = await coll.estimatedDocumentCount();
const stBefore = await db.command({ collStats: 'episodic_events' });
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`before: ${docsBefore} docs, ${(stBefore.size / 1048576).toFixed(1)} MB on disk, ${(stBefore.totalIndexSize / 1048576).toFixed(1)} MB index`);

// ── group ───────────────────────────────────────────────────────────────────
const groups = new Map(); // key -> { type, user, survivor, rows: [{_id, ts, desc, occ}] }
let scanned = 0;

const types = await coll.distinct('event_type');
const mergeable = types.filter(t => !RAW_EVENT_TYPES.has(t));
console.log(`mergeable event types: ${mergeable.length} (raw types excluded: ${types.length - mergeable.length})`);

for (const type of mergeable) {
  const cursor = coll.find(
    { event_type: type },
    { projection: { _id: 1, user_id: 1, event_type: 1, content: 1, timestamp: 1, occurrences: 1, shared_id: 1 } },
  );
  for await (const d of cursor) {
    scanned++;
    const desc = descriptionOf(d.content);
    if (!desc || desc.length < 12) continue;
    const norm = normalizeProposition(desc);
    const tokens = norm ? norm.split(' ').length : 0;
    if (tokens < 4) continue;
    const keyHash = episodicPropositionKey(d.event_type, desc);
    if (!keyHash) continue;
    const key = `${d.user_id}\u0000${d.event_type}\u0000${d.shared_id || ''}\u0000${keyHash}`;
    let g = groups.get(key);
    if (!g) { g = { rows: [] }; groups.set(key, g); }
    g.rows.push({ _id: d._id, ts: d.timestamp || new Date(0), desc, occ: d.occurrences || 1, key: keyHash });
  }
}

// Two different quantities are easy to confuse here:
//   occurrence surplus = sum(occurrences) - 1 per group: events absorbed into
//                        the survivor's occurrence counter;
//   rows to delete     = rows.length - 1 per group: documents the apply removes.
// Print both rather than labelling the occurrence count "redundant rows".
let groupsWithDupes = 0, occurrenceSurplus = 0, rowSurplus = 0;
for (const g of groups.values()) {
  if (g.rows.length > 1) {
    groupsWithDupes++;
    occurrenceSurplus += g.rows.reduce((a, r) => a + r.occ, 0) - 1;
    rowSurplus += g.rows.length - 1;
  }
}
console.log(`scanned ${scanned} docs -> ${groups.size} propositions`);
console.log(`groups with duplicates: ${groupsWithDupes}; occurrence surplus: ${occurrenceSurplus}; rows to delete: ${rowSurplus} (${(100 * rowSurplus / Math.max(1, scanned)).toFixed(1)}% of scanned)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to export and merge.');
  await client.close();
  process.exit(0);
}

// ── export, then merge + delete ─────────────────────────────────────────────
const gz = createGzip({ level: 6 });
const out = createWriteStream(OUT);
gz.pipe(out);
gz.on('error', e => { console.error('gzip error', e); process.exit(1); });
out.on('error', e => { console.error('export write error', e); process.exit(1); });

let exported = 0;
const write = async line => {
  if (!gz.write(line)) await once(gz, 'drain');
  exported++;
};

let toUpdate = [];
let toDelete = [];

for (const g of groups.values()) {
  if (g.rows.length < 2) continue;
  g.rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const survivor = g.rows[0];
  const rest = g.rows.slice(1);

  for (const r of rest) {
    await write(JSON.stringify({
      merged_into: survivor._id, key: r.key, timestamp: r.ts, description: r.desc, occurrences: r.occ,
    }) + '\n');
    toDelete.push(r._id);
  }

  const totalOcc = g.rows.reduce((a, r) => a + r.occ, 0);
  const variants = [...new Set(rest.map(r => r.desc))].slice(0, 5).map(t => ({ text: t, seen_at: new Date() }));
  toUpdate.push({
    updateOne: {
      filter: { _id: survivor._id },
      update: {
        $set: {
          proposition_key: survivor.key,
          occurrences: totalOcc,
          first_seen_at: new Date(survivor.ts),
          last_seen_at: new Date(rest[rest.length - 1].ts || survivor.ts),
          ...(variants.length ? { variants } : {}),
        },
      },
    },
  });
}

gz.end();
await once(out, 'finish');
console.log(`exported ${exported} rows to ${OUT}`);

let updated = 0;
for (let i = 0; i < toUpdate.length; i += 1000) {
  const res = await coll.bulkWrite(toUpdate.slice(i, i + 1000), { ordered: false });
  updated += res.modifiedCount || 0;
}
console.log(`survivors updated: ${updated}`);

let deleted = 0;
for (let i = 0; i < toDelete.length; i += 1000) {
  const res = await coll.deleteMany({ _id: { $in: toDelete.slice(i, i + 1000) } });
  deleted += res.deletedCount || 0;
  if (i % 50000 === 0) console.log(`  deleted ${deleted}/${toDelete.length}`);
}
console.log(`deleted: ${deleted} (exported ${exported})`);
if (deleted !== exported) {
  console.error(`⚠️ MISMATCH: exported ${exported} but deleted ${deleted} — export file kept for recovery`);
} else {
  console.log('export verified: line count matches deletes');
}

// ── unique sparse index: the atomic guard for concurrent first-writes ────────
// It can only be built after the duplicate groups above are gone. Same key as
// the runtime lookup index, so it serves both purposes.
try {
  await coll.dropIndex('proposition_lookup');
  console.log('dropped pre-merge proposition_lookup');
} catch (error) {
  if (error.code !== 27) throw error; // 27 = IndexNotFound
}
await coll.createIndex(
  { user_id: 1, event_type: 1, proposition_key: 1, shared_id: 1 },
  {
    name: 'proposition_lookup',
    unique: true,
    partialFilterExpression: { proposition_key: { $exists: true } },
    background: true,
  },
);
console.log('unique proposition_lookup ensured');

const docsAfter = await coll.estimatedDocumentCount();
const stAfter = await db.command({ collStats: 'episodic_events' });
console.log(`\nafter: ${docsAfter} docs (${docsAfter - docsBefore}), ${(stAfter.size / 1048576).toFixed(1)} MB on disk, ${(stAfter.totalIndexSize / 1048576).toFixed(1)} MB index`);
await client.close();
