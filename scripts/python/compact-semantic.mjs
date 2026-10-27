// semantic_facts compaction — exact-proposition dedupe with export-first.
// Lilly, 2026-10-21. DRY RUN by default; --apply writes.
//
//   node /app/compact-semantic.mjs                         # dry run
//   node /app/compact-semantic.mjs --apply                 # export + merge + delete
//   node /app/compact-semantic.mjs --repair-timestamps     # dry run of the 1970 repair
//   node /app/compact-semantic.mjs --repair-timestamps --apply

import { MongoClient } from 'mongodb';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const REPAIR = process.argv.includes('--repair-timestamps');
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB = process.env.DATABASE_NAME || 'katra';
const EXPORT_DIR = process.env.EXPORT_DIR || '/app/exports';
mkdirSync(EXPORT_DIR, { recursive: true });
const OUT = join(EXPORT_DIR, `semantic-merged-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`);

const STOPWORDS = new Set([
  'a','an','and','or','but','of','to','in','on','for','with','from','by','at','as',
  'is','are','was','were','be','been','being','that','this','these','those','it','its',
  'via','into','over','under','then','than','which','who','whom','has','have','had',
  'do','does','did','not','no','so','if','when','while','after','before','about',
]);
const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/).filter(w => w && w.length > 1 && !STOPWORDS.has(w)).sort().join(' ');

const client = new MongoClient(URI);
await client.connect();
const db = client.db(DB);
const coll = db.collection('semantic_facts');

// Repair mode (D3): the first compaction projected `timestamp`, which
// semantic_facts does not carry; survivors got 1970-01-01. Rebuild the two
// fields from created_at/updated_at. Dry run unless --apply.
if (REPAIR) {
  const cutoff = new Date('1980-01-01T00:00:00Z');
  const broken = coll.find(
    { first_seen_at: { $lt: cutoff }, created_at: { $exists: true } },
    { projection: { created_at: 1, updated_at: 1 } },
  );
  let count = 0;
  const ops = [];
  for await (const d of broken) {
    count++;
    ops.push({
      updateOne: {
        filter: { _id: d._id },
        update: {
          $set: {
            first_seen_at: d.created_at,
            last_seen_at: d.updated_at || d.created_at,
          },
        },
      },
    });
  }
  console.log(`timestamp repair: ${count} rows with first_seen_at < 1980 and created_at`);
  if (!APPLY) {
    console.log('DRY RUN — no repair written. Re-run with --repair-timestamps --apply.');
    await client.close();
    process.exit(0);
  }
  let repaired = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await coll.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    repaired += res.modifiedCount || 0;
  }
  console.log(`timestamp repair: ${repaired} rows updated`);
  await client.close();
  process.exit(0);
}

const st0 = await db.command({ collStats: 'semantic_facts' });
const n0 = await coll.estimatedDocumentCount();
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`semantic_facts: ${n0} docs | ${(st0.size / 1048576).toFixed(0)} MB logical | ${(st0.storageSize / 1048576).toFixed(0)} MB on disk`);

const groups = new Map();
let scanned = 0;
for await (const d of coll.find({}, { projection: { content: 1, user_id: 1, created_at: 1, updated_at: 1, timestamp: 1 } })) {
  scanned++;
  const text = typeof d.content === 'string' ? d.content : JSON.stringify(d.content || '');
  const norm = normalize(text);
  if (!norm) continue;
  const created = d.created_at || d.timestamp || null;
  const updated = d.updated_at || d.created_at || d.timestamp || null;
  const key = `${d.user_id || ''}\u0000${normalize(text)}`;
  let g = groups.get(key);
  if (!g) { g = { key, rows: [] }; groups.set(key, g); }
  g.rows.push({ _id: d._id, ts: created || new Date(0), last: updated || created || new Date(0), text });
}

let dupGroups = 0, redundant = 0;
for (const g of groups.values()) { if (g.rows.length > 1) { dupGroups++; redundant += g.rows.length - 1; } }
console.log(`scanned ${scanned} -> ${groups.size} propositions; duplicate groups ${dupGroups}; redundant ${redundant}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written.');
  await client.close();
  process.exit(0);
}

await coll.createIndex({ user_id: 1, proposition_key: 1 }, { name: 'semantic_proposition', background: true });

const gz = createGzip({ level: 6 });
const out = createWriteStream(OUT);
gz.pipe(out);
gz.on('error', e => { console.error('gzip error', e); process.exit(1); });
out.on('error', e => { console.error('export write error', e); process.exit(1); });
let exported = 0;
const write = async line => { if (!gz.write(line)) await once(gz, 'drain'); exported++; };

const updates = [];
const deletes = [];

for (const g of groups.values()) {
  if (g.rows.length < 2) continue;
  g.rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const kept = g.rows[0];
  for (const r of g.rows.slice(1)) {
    await write(JSON.stringify({ merged_into: kept._id, user_key: g.key.split('\u0000')[0], created_at: r.ts, updated_at: r.last, content: r.text }) + '\n');
    deletes.push(r._id);
  }
  const last = g.rows[g.rows.length - 1];
  updates.push({
    updateOne: {
      filter: { _id: kept._id },
      update: {
        $set: {
          proposition_key: createHash('sha256').update(g.key).digest('hex').slice(0, 32),
          occurrences: g.rows.length,
          first_seen_at: new Date(kept.ts),
          last_seen_at: new Date(last.last || last.ts),
        },
      },
    },
  });
}

gz.end();
await once(out, 'finish');
console.log(`exported ${exported} rows to ${OUT}`);
let updated = 0;
for (let i = 0; i < updates.length; i += 1000) {
  const res = await coll.bulkWrite(updates.slice(i, i + 1000), { ordered: false });
  updated += res.modifiedCount || 0;
}
let deleted = 0;
for (let i = 0; i < deletes.length; i += 1000) {
  const res = await coll.deleteMany({ _id: { $in: deletes.slice(i, i + 1000) } });
  deleted += res.deletedCount || 0;
  if (i % 20000 === 0) console.log(`  deleted ${deleted}/${deletes.length}`);
}
console.log(deleted === exported ? 'export verified: matches deletes' : `⚠️ MISMATCH exported=${exported} deleted=${deleted}`);

const st1 = await db.command({ collStats: 'semantic_facts' });
const n1 = await coll.estimatedDocumentCount();
console.log(`\nafter: ${n0} -> ${n1} docs | ${(st0.size / 1048576).toFixed(0)} -> ${(st1.size / 1048576).toFixed(0)} MB logical`);
await client.close();
