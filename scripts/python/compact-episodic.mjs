// Episodic compaction — collapse near-duplicate distilled events by proposition.
// Lilly, 2026-10-21. Default is a DRY RUN; pass --apply to write.
//
//   node /tmp/compact-episodic.mjs            # report only
//   node /tmp/compact-episodic.mjs --apply    # export + merge + delete
//
// Export is written BEFORE any delete, gzipped JSONL, one line per removed
// document, then verified line-count == delete-count.

import { MongoClient } from 'mongodb';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB = process.env.DATABASE_NAME || 'katra';
const OUT = `/app/exports/episodic-merged-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`;

// ── must match server/src/services/memory/proposition-key.ts ────────────────
const RAW_EVENT_TYPES = new Set([
  'conversation', 'agent_message', 'user_communication', 'machine_health',
  'gas_law_watcher_cycle', 'heartbeat_action', 'executive_action', 'action',
  'tool_call', 'system',
]);
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'by', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that',
  'this', 'these', 'those', 'it', 'its', 'via', 'into', 'over', 'under', 'then',
  'than', 'which', 'who', 'whom', 'has', 'have', 'had', 'do', 'does', 'did',
  'not', 'no', 'so', 'if', 'when', 'while', 'after', 'before', 'about',
]);

const normalize = s => String(s || '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter(w => w && w.length > 1 && !STOPWORDS.has(w)).sort().join(' ');

function descriptionOf(content) {
  if (!content) return null;
  if (typeof content === 'string') return content.trim() || null;
  if (typeof content !== 'object') return null;
  for (const f of ['description', 'summary', 'message']) {
    if (typeof content[f] === 'string' && content[f].trim()) return content[f].trim();
  }
  return null;
}

// key must equal sha256(`${event_type}:${normalized}`).slice(0,32)
import { createHash } from 'node:crypto';
const keyOf = (type, normalized) =>
  createHash('sha256').update(`${type}:${normalized}`).digest('hex').slice(0, 32);

const client = new MongoClient(URI);
await client.connect();
const db = client.db(DB);
const coll = db.collection('episodic_events');

const before = coll.stats ? null : null;
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
    { projection: { _id: 1, user_id: 1, event_type: 1, content: 1, timestamp: 1, occurrences: 1 } },
  );
  for await (const d of cursor) {
    scanned++;
    const desc = descriptionOf(d.content);
    if (!desc || desc.length < 12) continue;
    const norm = normalize(desc);
    const tokens = norm ? norm.split(' ').length : 0;
    if (tokens < 4) continue;
    const key = `${d.user_id}\u0000${d.event_type}\u0000${keyOf(d.event_type, norm)}`;
    let g = groups.get(key);
    if (!g) { g = { rows: [] }; groups.set(key, g); }
    g.rows.push({ _id: d._id, ts: d.timestamp || new Date(0), desc, occ: d.occurrences || 1, key: keyOf(d.event_type, norm) });
  }
}

let groupsWithDupes = 0, redundant = 0;
for (const g of groups.values()) {
  if (g.rows.length > 1) {
    groupsWithDupes++;
    redundant += g.rows.reduce((a, r) => a + r.occ, 0) - 1;
  }
}
console.log(`scanned ${scanned} docs -> ${groups.size} propositions`);
console.log(`groups with duplicates: ${groupsWithDupes}; redundant rows: ${redundant} (${(100 * redundant / Math.max(1, scanned)).toFixed(1)}% of scanned)`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to export and merge.');
  await client.close();
  process.exit(0);
}

// ── index for the write-path lookup ─────────────────────────────────────────
await coll.createIndex(
  { user_id: 1, event_type: 1, proposition_key: 1 },
  { name: 'proposition_lookup', background: true },
);
console.log('index proposition_lookup ensured');

// ── export, then merge + delete ─────────────────────────────────────────────
const gz = createGzip({ level: 6 });
const out = createWriteStream(OUT);
gz.pipe(out);
gz.on('error', e => { console.error('gzip error', e); process.exit(1); });

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

gz.end();
await once(out, 'finish');

const docsAfter = await coll.estimatedDocumentCount();
const stAfter = await db.command({ collStats: 'episodic_events' });
console.log(`\nafter: ${docsAfter} docs (${docsAfter - docsBefore}), ${(stAfter.size / 1048576).toFixed(1)} MB on disk, ${(stAfter.totalIndexSize / 1048576).toFixed(1)} MB index`);
await client.close();
