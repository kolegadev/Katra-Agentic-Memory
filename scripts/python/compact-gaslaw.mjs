// Structured-decision compaction: gas_law_train_decision, keyed by (cell, action).
// the loop director, 2026-10-21. DRY RUN by default; --apply exports then merges.
//
//   node /app/compact-gaslaw.mjs
//   node /app/compact-gaslaw.mjs --apply

import { MongoClient } from 'mongodb';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB = process.env.DATABASE_NAME || 'katra';
const TYPE = 'gas_law_train_decision';
const EXPORT_DIR = process.env.EXPORT_DIR || '/app/exports';
mkdirSync(EXPORT_DIR, { recursive: true });
const OUT = join(EXPORT_DIR, `${TYPE}-merged-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.gz`);

const client = new MongoClient(URI);
await client.connect();
const db = client.db(DB);
const coll = db.collection('episodic_events');

const st0 = await db.command({ collStats: 'episodic_events' });
const n0 = await coll.countDocuments({ event_type: TYPE });
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`${TYPE}: ${n0} rows | store ${(st0.size / 1048576).toFixed(1)} MB`);

const groups = new Map();
for await (const d of coll.find({ event_type: TYPE }, {
  projection: { _id: 1, user_id: 1, event_type: 1, content: 1, timestamp: 1, occurrences: 1, confidence: 1 },
})) {
  const c = d.content || {};
  const cell = c.cell_id ?? c.cell_name;
  const action = c.action;
  if (cell === undefined || typeof action !== 'string' || !action.trim()) continue;
  const normalized = `cell:${String(cell)}|action:${action.trim().toLowerCase()}`;
  const key = createHash('sha256').update(`${TYPE}:${normalized}`).digest('hex').slice(0, 32);
  const k = `${d.user_id}\u0000${key}`;
  let g = groups.get(k);
  if (!g) { g = { key, rows: [] }; groups.set(k, g); }
  g.rows.push({ _id: d._id, ts: d.timestamp || new Date(0), occ: d.occurrences || 1 });
}

let dupGroups = 0, redundant = 0;
for (const g of groups.values()) {
  if (g.rows.length > 1) { dupGroups++; redundant += g.rows.length - 1; }
}
console.log(`decisions: ${groups.size}; groups with repeats: ${dupGroups}; redundant rows: ${redundant}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written.');
  await client.close();
  process.exit(0);
}

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
  const latest = g.rows[g.rows.length - 1];   // keep the newest rationale
  const first = g.rows[0];
  const total = g.rows.reduce((a, r) => a + r.occ, 0);

  for (const r of g.rows) {
    if (r === latest) continue;
    await write(JSON.stringify({ merged_into: latest._id, key: g.key, timestamp: r.ts }) + '\n');
    deletes.push(r._id);
  }

  updates.push({
    updateOne: {
      filter: { _id: latest._id },
      update: {
        $set: {
          proposition_key: g.key,
          occurrences: total,
          first_seen_at: new Date(first.ts),
          last_seen_at: new Date(latest.ts),
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
console.log(`survivors updated: ${updated}`);

let deleted = 0;
for (let i = 0; i < deletes.length; i += 1000) {
  const res = await coll.deleteMany({ _id: { $in: deletes.slice(i, i + 1000) } });
  deleted += res.deletedCount || 0;
  if (i % 20000 === 0) console.log(`  deleted ${deleted}/${deletes.length}`);
}
console.log(deleted === exported ? 'export verified: matches deletes' : `⚠️ MISMATCH exported=${exported} deleted=${deleted}`);

const st1 = await db.command({ collStats: 'episodic_events' });
const n1 = await coll.countDocuments({ event_type: TYPE });
console.log(`\n${TYPE}: ${n0} -> ${n1} rows | store ${(st0.size / 1048576).toFixed(1)} -> ${(st1.size / 1048576).toFixed(1)} MB`);
await client.close();
