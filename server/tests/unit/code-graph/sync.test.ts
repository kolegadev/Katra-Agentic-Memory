/**
 * Unit tests: CodeGraphSync (F3)
 *
 * Covers the sync engine against the shared Mongo test helpers (test_-
 * prefixed collections, cleanup in afterAll): exact node/edge document
 * shapes incl. code_root, replacement on re-sync of a modified file (no
 * accumulation), full retraction on deletion, untouched fragments for
 * unchanged files, the shrink guard for failed extractions, legacy-node and
 * other-root retraction safety, edge id format, status(), recordSync(), and
 * bulkWrite chunking > 500 ops. When no MongoDB is reachable (default URI or
 * MONGODB_URI env), the suite is skipped so the unit run stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  cleanupTestData,
  closeTestDB,
  getTestDB,
  testCollection,
} from '../../helpers/db.js';
import { CodeGraphSync } from '../../../src/services/code-graph/code-graph-sync.js';
import type {
  ChangeSet,
  CodeNode,
  FileExtraction,
} from '../../../src/services/code-graph/types.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip the suite when unavailable.
let mongoAvailable = false;
try {
  const probe = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  await probe.connect();
  await probe.close();
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

/** Sync root for most tests; the status test uses its own root for isolation. */
const ROOT = resolve('/tmp/katra-f3-sync-unit-root');
const STATUS_ROOT = resolve('/tmp/katra-f3-sync-status-root');

/** Unique test collection names (unit vs integration suites run in parallel). */
const collections = {
  nodes: testCollection('knowledge_nodes'),
  relationships: testCollection('knowledge_relationships'),
  syncLog: testCollection('code_sync_log'),
  scanState: testCollection('code_scan_state_sync'),
};

/** Fabricate a ChangeSet from a partial spec. */
function cs(partial: Partial<ChangeSet>): ChangeSet {
  return {
    added: [],
    modified: [],
    deleted: [],
    unchanged: [],
    total: 0,
    ...partial,
  };
}

/** Build a small fake fragment: file node + one function node per name. */
function fileExtraction(relPath: string, fnNames: string[]): FileExtraction {
  const stem = relPath.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '_');
  const nodes: CodeNode[] = [
    {
      id: stem,
      label: relPath.split('/').pop() ?? relPath,
      kind: 'file',
      sourceFile: relPath,
      sourceLocation: 'L1',
    },
    ...fnNames.map((name) => ({
      id: `${stem}_${name}`,
      label: `${name}()`,
      kind: 'function' as const,
      sourceFile: relPath,
      sourceLocation: 'L2',
    })),
  ];
  const edges = fnNames.map((name) => ({
    from: stem,
    to: `${stem}_${name}`,
    relation: 'contains' as const,
    confidence: 'EXTRACTED' as const,
    weight: 1,
    sourceFile: relPath,
  }));
  return { nodes, edges, errors: [] };
}

describe.skipIf(!mongoAvailable)('CodeGraphSync', () => {
  let sync: CodeGraphSync;
  let db: Awaited<ReturnType<typeof getTestDB>>;

  const nodes = () => db.collection(collections.nodes);
  const relationships = () => db.collection(collections.relationships);

  beforeAll(async () => {
    db = await getTestDB();
    sync = new CodeGraphSync(db, collections);
    for (const name of Object.values(collections)) {
      await db.collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await cleanupTestData('knowledge_nodes');
    await cleanupTestData('knowledge_relationships');
    await cleanupTestData('code_sync_log');
    await cleanupTestData('code_scan_state_sync');
    await closeTestDB();
  });

  it('upserts nodes with the exact document shape, incl. code_root', async () => {
    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/one.ts'], total: 1 }),
      new Map([['src/one.ts', fileExtraction('src/one.ts', ['foo'])]]),
    );

    expect(result).toMatchObject({
      root: ROOT,
      scanned: 1,
      added: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      extracted: 1,
      failed: [],
      nodesUpserted: 2,
      edgesUpserted: 1,
      nodesRetracted: 0,
      edgesRetracted: 0,
    });

    const doc = await nodes().findOne({ id: 'graphify:src_one' });
    expect(doc).not.toBeNull();
    expect(Object.keys(doc!.properties).sort()).toEqual([
      'code_language',
      'code_root',
      'name',
      'source_file',
      'source_path',
      'summary',
    ]);
    expect(doc).toMatchObject({
      id: 'graphify:src_one',
      type: 'file',
      name: 'one.ts',
      properties: {
        name: 'one.ts',
        source_path: 'src/one.ts',
        source_file: 'src/one.ts',
        code_language: 'typescript',
        summary: 'Katra-code file: one.ts',
        code_root: ROOT,
      },
      source: 'katra-code',
      user_id: 'kolega-agent',
    });
    expect(doc!.created_at).toBeInstanceOf(Date);
    expect(doc!.updated_at).toBeInstanceOf(Date);
  });

  it('upserts edges with the exact id/shape: graphify:edge:from:relation:to', async () => {
    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/one-e.ts'], total: 1 }),
      new Map([['src/one-e.ts', fileExtraction('src/one-e.ts', ['foo'])]]),
    );
    expect(result.edgesUpserted).toBe(1);

    const doc = await relationships().findOne({
      id: 'graphify:edge:graphify:src_one_e:contains:graphify:src_one_e_foo',
    });
    expect(doc).not.toBeNull();
    expect(doc).toMatchObject({
      id: 'graphify:edge:graphify:src_one_e:contains:graphify:src_one_e_foo',
      relationship_type: 'contains',
      from_id: 'graphify:src_one_e',
      to_id: 'graphify:src_one_e_foo',
      strength: 1,
      properties: {
        weight: 1,
        source_file: 'src/one-e.ts',
        code_root: ROOT,
      },
      source: 'katra-code',
      user_id: 'kolega-agent',
    });
    expect(doc!.created_at).toBeInstanceOf(Date);
    expect(doc!.updated_at).toBeInstanceOf(Date);
  });

  it('re-sync of a MODIFIED file replaces its fragment (no accumulation)', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/two.ts'], total: 1 }),
      new Map([['src/two.ts', fileExtraction('src/two.ts', ['foo', 'bar'])]]),
    );

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/two.ts'], total: 1 }),
      new Map([['src/two.ts', fileExtraction('src/two.ts', ['foo', 'baz'])]]),
    );

    expect(result.failed).toEqual([]);
    expect(result.nodesRetracted).toBe(3); // file + foo + bar
    expect(result.edgesRetracted).toBe(2); // contains → foo, contains → bar
    expect(result.nodesUpserted).toBe(3); // file + foo modified, baz inserted
    expect(result.edgesUpserted).toBe(2); // contains → foo + contains → baz

    // Old symbol gone, new symbol present, no accumulation.
    expect(await nodes().findOne({ id: 'graphify:src_two_bar' })).toBeNull();
    const ids = await nodes()
      .find({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/two.ts',
      })
      .map((d) => d.id)
      .toArray();
    expect(ids.sort()).toEqual([
      'graphify:src_two',
      'graphify:src_two_baz',
      'graphify:src_two_foo',
    ]);
    const edges = await relationships()
      .find({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/two.ts',
      })
      .map((d) => d.id)
      .toArray();
    expect(edges.sort()).toEqual([
      'graphify:edge:graphify:src_two:contains:graphify:src_two_baz',
      'graphify:edge:graphify:src_two:contains:graphify:src_two_foo',
    ]);
  });

  it('DELETED file fully retracts its nodes AND edges', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/three.ts'], total: 1 }),
      new Map([['src/three.ts', fileExtraction('src/three.ts', ['foo', 'bar'])]]),
    );

    const result = await sync.sync(
      ROOT,
      cs({ deleted: ['src/three.ts'], total: 0 }),
      new Map(),
    );

    expect(result.nodesRetracted).toBe(3);
    expect(result.edgesRetracted).toBe(2);
    expect(result.nodesUpserted).toBe(0);
    expect(result.edgesUpserted).toBe(0);

    expect(
      await nodes().countDocuments({
        id: { $regex: '^graphify:' },
        'properties.code_root': ROOT,
        'properties.source_file': 'src/three.ts',
      }),
    ).toBe(0);
    expect(
      await relationships().countDocuments({
        id: { $regex: '^graphify:edge:' },
        'properties.code_root': ROOT,
        'properties.source_file': 'src/three.ts',
      }),
    ).toBe(0);
  });

  it("leaves an unmodified file's fragment untouched", async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/four.ts'], total: 1 }),
      new Map([['src/four.ts', fileExtraction('src/four.ts', ['foo'])]]),
    );
    const before = await nodes().findOne({ id: 'graphify:src_four_foo' });

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/four-b.ts'], unchanged: ['src/four.ts'], total: 2 }),
      new Map([['src/four-b.ts', fileExtraction('src/four-b.ts', ['qux'])]]),
    );

    expect(result.nodesRetracted).toBe(0); // four-b had no prior fragment
    expect(await nodes().findOne({ id: 'graphify:src_four_b_qux' })).not.toBeNull();
    const after = await nodes().findOne({ id: 'graphify:src_four_foo' });
    expect(after).not.toBeNull();
    expect(after!.updated_at).toEqual(before!.updated_at);
  });

  it('failed file (absent extraction) keeps the old fragment and is listed in result.failed', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/five.ts'], total: 1 }),
      new Map([['src/five.ts', fileExtraction('src/five.ts', ['foo', 'bar'])]]),
    );

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/five.ts'], total: 1 }),
      new Map(),
    );

    expect(result.failed).toEqual(['src/five.ts']);
    expect(result.nodesRetracted).toBe(0);
    expect(result.edgesRetracted).toBe(0);
    expect(result.nodesUpserted).toBe(0);
    expect(await nodes().findOne({ id: 'graphify:src_five_bar' })).not.toBeNull();
    expect(
      await nodes().countDocuments({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/five.ts',
      }),
    ).toBe(3);
  });

  it('failed file (errors with zero nodes) is shrink-guarded too', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/five-e.ts'], total: 1 }),
      new Map([['src/five-e.ts', fileExtraction('src/five-e.ts', ['foo'])]]),
    );

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/five-e.ts'], total: 1 }),
      new Map([
        ['src/five-e.ts', { nodes: [], edges: [], errors: ['parse failed'] }],
      ]),
    );

    expect(result.failed).toEqual(['src/five-e.ts']);
    expect(result.nodesRetracted).toBe(0);
    expect(await nodes().findOne({ id: 'graphify:src_five_e_foo' })).not.toBeNull();
  });

  it('merges partial progress (errors but non-zero nodes) normally', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/five-p.ts'], total: 1 }),
      new Map([['src/five-p.ts', fileExtraction('src/five-p.ts', ['foo'])]]),
    );

    const partial: FileExtraction = {
      nodes: [
        {
          id: 'src_five_p',
          label: 'five-p.ts',
          kind: 'file',
          sourceFile: 'src/five-p.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'src_five_p_ok',
          label: 'ok()',
          kind: 'function',
          sourceFile: 'src/five-p.ts',
          sourceLocation: 'L2',
        },
      ],
      edges: [],
      errors: ['truncated after ok'],
    };

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/five-p.ts'], total: 1 }),
      new Map([['src/five-p.ts', partial]]),
    );

    expect(result.failed).toEqual([]);
    expect(result.nodesRetracted).toBe(2); // old fragment pruned, then replaced
    expect(await nodes().findOne({ id: 'graphify:src_five_p_ok' })).not.toBeNull();
    expect(await nodes().findOne({ id: 'graphify:src_five_p_foo' })).toBeNull();
  });

  it('never retracts a legacy node with the same id but NO code_root', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/six.ts'], total: 1 }),
      new Map([['src/six.ts', fileExtraction('src/six.ts', ['foo'])]]),
    );
    // Legacy graphify-seed node: same id as the native function node,
    // same source_file, but no code_root (Graphify pipeline owns it).
    await nodes().insertOne({
      id: 'graphify:src_six_foo',
      type: 'function',
      name: 'legacy foo()',
      properties: {
        name: 'legacy foo()',
        source_path: 'src/six.ts',
        source_file: 'src/six.ts',
        code_language: 'typescript',
        summary: 'Graphify-seeded function: legacy foo()',
      },
      source: 'graphify-seed',
      user_id: 'kolega-agent',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const result = await sync.sync(
      ROOT,
      cs({ deleted: ['src/six.ts'], total: 0 }),
      new Map(),
    );
    expect(result.nodesRetracted).toBe(2); // file + native foo only

    expect(
      await nodes().findOne({ id: 'graphify:src_six_foo', source: 'katra-code' }),
    ).toBeNull();
    expect(
      await nodes().findOne({ id: 'graphify:src_six_foo', source: 'graphify-seed' }),
    ).not.toBeNull();
    expect(
      await nodes().findOne({
        id: 'graphify:src_six_foo',
        'properties.code_root': { $exists: false },
      }),
    ).not.toBeNull();
  });

  it('never retracts a node with the same source_file but a DIFFERENT code_root', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/seven.ts'], total: 1 }),
      new Map([['src/seven.ts', fileExtraction('src/seven.ts', ['foo'])]]),
    );
    await nodes().insertOne({
      id: 'graphify:other_root_foo',
      type: 'function',
      name: 'foo()',
      properties: {
        name: 'foo()',
        source_path: 'src/seven.ts',
        source_file: 'src/seven.ts',
        code_language: 'typescript',
        summary: 'Katra-code function: foo()',
        code_root: '/tmp/katra-f3-other-root',
      },
      source: 'katra-code',
      user_id: 'kolega-agent',
      created_at: new Date(),
      updated_at: new Date(),
    });

    await sync.sync(ROOT, cs({ deleted: ['src/seven.ts'], total: 0 }), new Map());

    expect(await nodes().findOne({ id: 'graphify:other_root_foo' })).not.toBeNull();
    expect(await nodes().findOne({ id: 'graphify:src_seven_foo' })).toBeNull();
  });

  it('status() reports root-owned counts and the manifest lastSyncAt', async () => {
    await sync.sync(
      STATUS_ROOT,
      cs({ added: ['status.ts'], total: 1 }),
      new Map([['status.ts', fileExtraction('status.ts', ['go'])]]),
    );

    expect(await sync.status(STATUS_ROOT)).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      lastSyncAt: null,
    });

    // Manifest document in the exact manifest-store shape (direct find).
    await db.collection(collections.scanState).insertOne({
      _id: createHash('sha256').update(STATUS_ROOT).digest('hex'),
      root: STATUS_ROOT,
      updatedAt: '2026-01-01T00:00:00.000Z',
      files: {},
    });

    const status = await sync.status(STATUS_ROOT);
    expect(status.lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
    expect(status.nodeCount).toBe(2);
  });

  it('recordSync() appends one code_sync_log document per sync', async () => {
    const result = await sync.sync(
      STATUS_ROOT,
      cs({ modified: ['status.ts'], total: 1 }),
      new Map([['status.ts', fileExtraction('status.ts', ['go', 'run'])]]),
    );
    await sync.recordSync(result);

    const log = db.collection(collections.syncLog);
    expect(await log.countDocuments({})).toBe(1);
    const doc = await log.findOne({ root: STATUS_ROOT });
    expect(doc).not.toBeNull();
    expect(doc!.at).toBeInstanceOf(Date);
    expect(doc).toMatchObject({
      root: STATUS_ROOT,
      modified: 1,
      failed: [],
      nodesUpserted: 3, // file + go modified, run inserted
      edgesUpserted: 2,
    });
  });

  it('splits bulk upserts into chunks of ≤ 500 ops', async () => {
    const fnNames = Array.from({ length: 1200 }, (_, i) => `fn${i}`);
    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/many.ts'], total: 1 }),
      new Map([['src/many.ts', fileExtraction('src/many.ts', fnNames)]]),
    );

    expect(result.nodesUpserted).toBe(1201); // file + 1200 functions
    expect(result.edgesUpserted).toBe(1200);
    expect(
      await nodes().countDocuments({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/many.ts',
      }),
    ).toBe(1201);
    expect(
      await relationships().countDocuments({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/many.ts',
      }),
    ).toBe(1200);
  });
});
