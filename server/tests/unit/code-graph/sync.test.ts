/**
 * Unit tests: CodeGraphSync (F3)
 *
 * Covers the sync engine against the shared Mongo test helpers (test_-
 * prefixed collections, cleanup in afterAll): exact node/edge document
 * shapes incl. code_root and ROOT-SCOPED ids (`graphify:<rootKey>:<stem>`,
 * `graphify:edge:<rootKey>:<fromId>:<rel>:<toId>`), replacement on re-sync
 * of a modified file (no accumulation), full retraction on deletion,
 * untouched fragments for unchanged files, the shrink guard for failed
 * extractions, legacy-node and other-root retraction safety, cross-root
 * isolation for two roots with IDENTICAL relative paths (the F3 verifier
 * collision), edge id format, status(), recordSync(), and bulkWrite chunking
 * > 500 ops. When no MongoDB is reachable (default URI or MONGODB_URI env),
 * the suite is skipped so the unit run stays green.
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

/** Root-scoped key per CONTRACT: first 12 hex chars of sha256(resolve(root)). */
function rootKeyFor(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
}

/** Root-scoped stored node id for the main ROOT: `graphify:<rootKey>:<stem>`. */
const nid = (extractorId: string) =>
  `graphify:${rootKeyFor(ROOT)}:${extractorId}`;

/** Root-scoped stored edge id for the main ROOT. */
const eid = (from: string, relation: string, to: string) =>
  `graphify:edge:${rootKeyFor(ROOT)}:${nid(from)}:${relation}:${nid(to)}`;

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

  it('upserts nodes with the exact document shape, incl. code_root and root-scoped id', async () => {
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

    const doc = await nodes().findOne({ id: nid('src_one') });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(nid('src_one'));
    expect(doc!.id).toMatch(/^graphify:[0-9a-f]{12}:src_one$/);
    expect(Object.keys(doc!.properties).sort()).toEqual([
      'code_language',
      'code_root',
      'name',
      'source_file',
      'source_path',
      'summary',
    ]);
    expect(doc).toMatchObject({
      id: nid('src_one'),
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

  it('upserts edges with the exact id/shape: graphify:edge:<rootKey>:<fromId>:<rel>:<toId>', async () => {
    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/one-e.ts'], total: 1 }),
      new Map([['src/one-e.ts', fileExtraction('src/one-e.ts', ['foo'])]]),
    );
    expect(result.edgesUpserted).toBe(1);

    const expectedId = eid('src_one_e', 'contains', 'src_one_e_foo');
    const doc = await relationships().findOne({ id: expectedId });
    expect(doc).not.toBeNull();
    expect(doc!.id).toMatch(
      /^graphify:edge:[0-9a-f]{12}:graphify:[0-9a-f]{12}:src_one_e:contains:graphify:[0-9a-f]{12}:src_one_e_foo$/,
    );
    expect(doc).toMatchObject({
      id: expectedId,
      relationship_type: 'contains',
      from_id: nid('src_one_e'),
      to_id: nid('src_one_e_foo'),
      strength: 1,
      properties: {
        weight: 1,
        confidence: 'EXTRACTED',
        source_file: 'src/one-e.ts',
        code_root: ROOT,
      },
      source: 'katra-code',
      user_id: 'kolega-agent',
    });
    expect(doc!.created_at).toBeInstanceOf(Date);
    expect(doc!.updated_at).toBeInstanceOf(Date);
  });

  it('persists edge confidence as emitted (EXTRACTED and INFERRED)', async () => {
    const extraction: FileExtraction = {
      nodes: [
        {
          id: 'src_conf',
          label: 'conf.ts',
          kind: 'file',
          sourceFile: 'src/conf.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'src_conf_go',
          label: 'go()',
          kind: 'function',
          sourceFile: 'src/conf.ts',
          sourceLocation: 'L2',
        },
        {
          id: 'src_conf_run',
          label: 'run()',
          kind: 'function',
          sourceFile: 'src/conf.ts',
          sourceLocation: 'L3',
        },
      ],
      edges: [
        {
          from: 'src_conf',
          to: 'src_conf_go',
          relation: 'contains',
          confidence: 'EXTRACTED',
          weight: 1,
          sourceFile: 'src/conf.ts',
        },
        {
          from: 'src_conf',
          to: 'src_conf_run',
          relation: 'calls',
          confidence: 'INFERRED',
          weight: 1,
          sourceFile: 'src/conf.ts',
        },
      ],
      errors: [],
    };

    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/conf.ts'], total: 1 }),
      new Map([['src/conf.ts', extraction]]),
    );
    expect(result.edgesUpserted).toBe(2);
    expect(result.edgesDropped).toBe(0);

    const extracted = await relationships().findOne({
      id: eid('src_conf', 'contains', 'src_conf_go'),
    });
    const inferred = await relationships().findOne({
      id: eid('src_conf', 'calls', 'src_conf_run'),
    });
    expect(extracted?.properties.confidence).toBe('EXTRACTED');
    expect(inferred?.properties.confidence).toBe('INFERRED');
  });

  it('drops an edge whose endpoint matches no node, counts it in edgesDropped, and keeps the valid sibling', async () => {
    const extraction: FileExtraction = {
      nodes: [
        {
          id: 'src_dng',
          label: 'dng.ts',
          kind: 'file',
          sourceFile: 'src/dng.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'src_dng_real',
          label: 'real()',
          kind: 'function',
          sourceFile: 'src/dng.ts',
          sourceLocation: 'L2',
        },
      ],
      edges: [
        {
          from: 'src_dng',
          to: 'src_dng_real',
          relation: 'contains',
          confidence: 'EXTRACTED',
          weight: 1,
          sourceFile: 'src/dng.ts',
        },
        {
          from: 'src_dng',
          to: 'src_ghost_never',
          relation: 'calls',
          confidence: 'INFERRED',
          weight: 1,
          sourceFile: 'src/dng.ts',
        },
      ],
      errors: [],
    };

    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/dng.ts'], total: 1 }),
      new Map([['src/dng.ts', extraction]]),
    );
    expect(result.edgesDropped).toBe(1);
    expect(result.edgesUpserted).toBe(1);
    expect(
      await relationships().findOne({
        id: eid('src_dng', 'contains', 'src_dng_real'),
      }),
    ).not.toBeNull();
    expect(
      await relationships().findOne({
        id: eid('src_dng', 'calls', 'src_ghost_never'),
      }),
    ).toBeNull();
  });

  it('keeps an edge into a node of an UNCHANGED file already in the DB', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/un.ts'], total: 1 }),
      new Map([['src/un.ts', fileExtraction('src/un.ts', ['foo'])]]),
    );

    const newFile: FileExtraction = {
      nodes: [
        {
          id: 'src_newer',
          label: 'newer.ts',
          kind: 'file',
          sourceFile: 'src/newer.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'src_newer_main',
          label: 'main()',
          kind: 'function',
          sourceFile: 'src/newer.ts',
          sourceLocation: 'L2',
        },
      ],
      edges: [
        {
          from: 'src_newer_main',
          to: 'src_un_foo',
          relation: 'calls',
          confidence: 'INFERRED',
          weight: 1,
          sourceFile: 'src/newer.ts',
        },
      ],
      errors: [],
    };

    const result = await sync.sync(
      ROOT,
      cs({ added: ['src/newer.ts'], unchanged: ['src/un.ts'], total: 2 }),
      new Map([['src/newer.ts', newFile]]),
    );
    expect(result.edgesDropped).toBe(0);
    expect(result.edgesUpserted).toBe(1);
    expect(
      await relationships().findOne({
        id: eid('src_newer_main', 'calls', 'src_un_foo'),
      }),
    ).not.toBeNull();
  });

  it('drops an edge into a node RETRACTED in the same run', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/ret.ts'], total: 1 }),
      new Map([['src/ret.ts', fileExtraction('src/ret.ts', ['oldfn'])]]),
    );

    const linkFile: FileExtraction = {
      nodes: [
        {
          id: 'src_link',
          label: 'link.ts',
          kind: 'file',
          sourceFile: 'src/link.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'src_link_main',
          label: 'main()',
          kind: 'function',
          sourceFile: 'src/link.ts',
          sourceLocation: 'L2',
        },
      ],
      edges: [
        {
          from: 'src_link_main',
          to: 'src_ret_oldfn',
          relation: 'calls',
          confidence: 'INFERRED',
          weight: 1,
          sourceFile: 'src/link.ts',
        },
      ],
      errors: [],
    };

    // src/ret.ts is modified and its new fragment no longer defines oldfn:
    // oldfn is retracted in the same run, so the link edge into it must be
    // dropped rather than stored against a node that is gone.
    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/ret.ts'], added: ['src/link.ts'], total: 2 }),
      new Map([
        ['src/ret.ts', fileExtraction('src/ret.ts', ['newfn'])],
        ['src/link.ts', linkFile],
      ]),
    );
    expect(result.edgesDropped).toBe(1);
    expect(result.nodesRetracted).toBe(2); // file + oldfn (fragment replaced)
    expect(
      await relationships().findOne({
        id: eid('src_link_main', 'calls', 'src_ret_oldfn'),
      }),
    ).toBeNull();
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
    expect(await nodes().findOne({ id: nid('src_two_bar') })).toBeNull();
    const ids = await nodes()
      .find({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/two.ts',
      })
      .map((d) => d.id)
      .toArray();
    expect(ids.sort()).toEqual([
      nid('src_two'),
      nid('src_two_baz'),
      nid('src_two_foo'),
    ]);
    const edges = await relationships()
      .find({
        'properties.code_root': ROOT,
        'properties.source_file': 'src/two.ts',
      })
      .map((d) => d.id)
      .toArray();
    expect(edges.sort()).toEqual([
      eid('src_two', 'contains', 'src_two_baz'),
      eid('src_two', 'contains', 'src_two_foo'),
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
    const before = await nodes().findOne({ id: nid('src_four_foo') });

    const result = await sync.sync(
      ROOT,
      cs({ modified: ['src/four-b.ts'], unchanged: ['src/four.ts'], total: 2 }),
      new Map([['src/four-b.ts', fileExtraction('src/four-b.ts', ['qux'])]]),
    );

    expect(result.nodesRetracted).toBe(0); // four-b had no prior fragment
    expect(await nodes().findOne({ id: nid('src_four_b_qux') })).not.toBeNull();
    const after = await nodes().findOne({ id: nid('src_four_foo') });
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
    expect(await nodes().findOne({ id: nid('src_five_bar') })).not.toBeNull();
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
    expect(await nodes().findOne({ id: nid('src_five_e_foo') })).not.toBeNull();
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
    expect(await nodes().findOne({ id: nid('src_five_p_ok') })).not.toBeNull();
    expect(await nodes().findOne({ id: nid('src_five_p_foo') })).toBeNull();
  });

  it('never retracts a legacy node with the same source_file but NO code_root', async () => {
    await sync.sync(
      ROOT,
      cs({ added: ['src/six.ts'], total: 1 }),
      new Map([['src/six.ts', fileExtraction('src/six.ts', ['foo'])]]),
    );
    // Legacy graphify-seed node: UNNAMESPACED id (pre-namespacing seed era),
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
      await nodes().findOne({ id: nid('src_six_foo'), source: 'katra-code' }),
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
    const otherRoot = resolve('/tmp/katra-f3-other-root');
    await nodes().insertOne({
      id: `graphify:${rootKeyFor(otherRoot)}:src_seven_foo`,
      type: 'function',
      name: 'foo()',
      properties: {
        name: 'foo()',
        source_path: 'src/seven.ts',
        source_file: 'src/seven.ts',
        code_language: 'typescript',
        summary: 'Katra-code function: foo()',
        code_root: otherRoot,
      },
      source: 'katra-code',
      user_id: 'kolega-agent',
      created_at: new Date(),
      updated_at: new Date(),
    });

    await sync.sync(ROOT, cs({ deleted: ['src/seven.ts'], total: 0 }), new Map());

    expect(
      await nodes().findOne({ id: `graphify:${rootKeyFor(otherRoot)}:src_seven_foo` }),
    ).not.toBeNull();
    expect(await nodes().findOne({ id: nid('src_seven_foo') })).toBeNull();
  });

  it('ISOLATES two roots with IDENTICAL relative paths in the shared graph (F3 verifier regression)', async () => {
    const rootA = resolve('/tmp/katra-f3-sync-root-a');
    const rootB = resolve('/tmp/katra-f3-sync-root-b');
    const keyA = rootKeyFor(rootA);
    const keyB = rootKeyFor(rootB);
    expect(keyA).toMatch(/^[0-9a-f]{12}$/);
    expect(keyA).not.toBe(keyB);

    // RankPilot and Katra both contain server/src/index.ts: identical
    // relPath AND identical extractor ids in both roots.
    const relPath = 'server/src/index.ts';
    const fragment = fileExtraction(relPath, ['handler']);

    const idA = (stem: string) => `graphify:${keyA}:${stem}`;
    const idB = (stem: string) => `graphify:${keyB}:${stem}`;
    const edgeA = `graphify:edge:${keyA}:${idA('server_src_index')}:contains:${idA('server_src_index_handler')}`;
    const edgeB = `graphify:edge:${keyB}:${idB('server_src_index')}:contains:${idB('server_src_index_handler')}`;

    // Sync root A, then root B: both fragments must coexist with distinct
    // root-scoped ids and their own code_root — no cross-root overwrite.
    await sync.sync(
      rootA,
      cs({ added: [relPath], total: 1 }),
      new Map([[relPath, fragment]]),
    );
    await sync.sync(
      rootB,
      cs({ added: [relPath], total: 1 }),
      new Map([[relPath, fragment]]),
    );

    const aNodeIds = await nodes()
      .find({
        'properties.code_root': rootA,
        'properties.source_file': relPath,
      })
      .map((d) => d.id)
      .toArray();
    const bNodeIds = await nodes()
      .find({
        'properties.code_root': rootB,
        'properties.source_file': relPath,
      })
      .map((d) => d.id)
      .toArray();
    expect(aNodeIds.sort()).toEqual(
      [idA('server_src_index'), idA('server_src_index_handler')].sort(),
    );
    expect(bNodeIds.sort()).toEqual(
      [idB('server_src_index'), idB('server_src_index_handler')].sort(),
    );
    for (const d of await nodes()
      .find({
        'properties.code_root': { $in: [rootA, rootB] },
        'properties.source_file': relPath,
      })
      .toArray()) {
      expect(d.id).toMatch(/^graphify:[0-9a-f]{12}:/);
    }
    expect(await relationships().findOne({ id: edgeA })).not.toBeNull();
    expect(await relationships().findOne({ id: edgeB })).not.toBeNull();

    // Retract the file from root B only (deleted): root B's fragment
    // disappears, root A's must be COMPLETELY intact.
    const deletion = await sync.sync(
      rootB,
      cs({ deleted: [relPath], total: 0 }),
      new Map(),
    );
    expect(deletion.nodesRetracted).toBe(2); // file + handler
    expect(deletion.edgesRetracted).toBe(1); // contains → handler

    expect(
      await nodes().countDocuments({
        'properties.code_root': rootB,
        'properties.source_file': relPath,
      }),
    ).toBe(0);
    expect(
      await relationships().countDocuments({
        'properties.code_root': rootB,
        'properties.source_file': relPath,
      }),
    ).toBe(0);

    // Root A: correct counts, correct code_root, correct stored ids.
    const aAfter = await nodes()
      .find({
        'properties.code_root': rootA,
        'properties.source_file': relPath,
      })
      .toArray();
    expect(aAfter.map((d) => d.id).sort()).toEqual(
      [idA('server_src_index'), idA('server_src_index_handler')].sort(),
    );
    for (const d of aAfter) {
      expect(d.properties.code_root).toBe(rootA);
      expect(d.properties.source_file).toBe(relPath);
      expect(d.properties.source_path).toBe(relPath);
      expect(d.source).toBe('katra-code');
    }
    expect(
      await relationships().countDocuments({
        'properties.code_root': rootA,
        'properties.source_file': relPath,
      }),
    ).toBe(1);
    const aEdge = await relationships().findOne({
      'properties.code_root': rootA,
      'properties.source_file': relPath,
    });
    expect(aEdge).not.toBeNull();
    expect(aEdge!.id).toBe(edgeA);
    expect(aEdge!.from_id).toBe(idA('server_src_index'));
    expect(aEdge!.to_id).toBe(idA('server_src_index_handler'));
    expect(aEdge!.properties.code_root).toBe(rootA);

    // status() agrees per root.
    expect((await sync.status(rootA)).nodeCount).toBe(2);
    expect((await sync.status(rootA)).edgeCount).toBe(1);
    expect((await sync.status(rootB)).nodeCount).toBe(0);
    expect((await sync.status(rootB)).edgeCount).toBe(0);
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
