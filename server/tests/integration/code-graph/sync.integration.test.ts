/**
 * Integration test: CodeGraphSync (F3) — real end-to-end sync against the
 * fixture tree under tests/fixtures/code-graph: scanCodebase (F1) →
 * extractFile (F2) → sync into test-prefixed KG collections, then a
 * fabricated deletion with re-sync asserting full physical retraction.
 * When no MongoDB is reachable, the suite is skipped so the integration run
 * stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import {
  cleanupTestData,
  closeTestDB,
  getTestDB,
  testCollection,
} from '../../helpers/db.js';
import { scanCodebase } from '../../../src/services/code-graph/codebase-scanner.js';
import { extractFile } from '../../../src/services/code-graph/codebase-extractor.js';
import { CodeGraphSync } from '../../../src/services/code-graph/code-graph-sync.js';
import type { ChangeSet, FileExtraction } from '../../../src/services/code-graph/types.js';

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

/** Fixture scan root: tests/fixtures/code-graph (relPaths are flat). */
const fixturesRoot = fileURLToPath(
  new URL('../../fixtures/code-graph', import.meta.url),
);

/** Distinct collection names so the unit sync suite can run in parallel. */
const collections = {
  nodes: testCollection('sync_it_nodes'),
  relationships: testCollection('sync_it_relationships'),
  syncLog: testCollection('sync_it_log'),
  scanState: testCollection('sync_it_state'),
};

describe.skipIf(!mongoAvailable)('CodeGraphSync (integration)', () => {
  let sync: CodeGraphSync;
  let db: Awaited<ReturnType<typeof getTestDB>>;

  beforeAll(async () => {
    db = await getTestDB();
    sync = new CodeGraphSync(db, collections);
    for (const name of Object.values(collections)) {
      await db.collection(name).deleteMany({});
    }
  });

  afterAll(async () => {
    await cleanupTestData('sync_it_nodes');
    await cleanupTestData('sync_it_relationships');
    await cleanupTestData('sync_it_log');
    await cleanupTestData('sync_it_state');
    await closeTestDB();
  });

  it('syncs the fixture tree end-to-end and fully retracts on deletion', async () => {
    // 1. F1 scan + classify: first scan classifies everything as added.
    const scanned = await scanCodebase(fixturesRoot);
    expect(scanned.length).toBeGreaterThan(0);

    const changes: ChangeSet = {
      added: scanned.map((f) => f.relPath),
      modified: [],
      deleted: [],
      unchanged: [],
      total: scanned.length,
    };

    // 2. F2 extraction for every scanned file.
    const extractions = new Map<string, FileExtraction>();
    for (const file of scanned) {
      extractions.set(
        file.relPath,
        await extractFile(
          fixturesRoot,
          file.relPath,
          await readFile(file.absPath),
        ),
      );
    }

    // 3. F3 sync — everything merges, nothing fails (sample-invalid.ts has
    //    errors but non-zero nodes → partial progress, not a failure).
    const result = await sync.sync(fixturesRoot, changes, extractions);
    expect(result.failed).toEqual([]);
    expect(result.nodesRetracted).toBe(0);
    expect(result.edgesRetracted).toBe(0);
    expect(result.nodesUpserted).toBeGreaterThan(0);
    expect(result.edgesUpserted).toBeGreaterThan(0);

    // Every emitted node/edge op applied on the first sync; deterministic
    // ID-based upserts collapse same-id entities (e.g. sample.py/sample.ts
    // share the `sample` stem → one file node), so stored docs = unique ids.
    const totalNodes = [...extractions.values()].reduce(
      (n, e) => n + e.nodes.length,
      0,
    );
    const totalEdges = [...extractions.values()].reduce(
      (n, e) => n + e.edges.length,
      0,
    );
    const uniqueNodeIds = new Set(
      [...extractions.values()].flatMap((e) => e.nodes.map((n) => n.id)),
    ).size;
    const uniqueEdgeKeys = new Set(
      [...extractions.values()].flatMap((e) =>
        e.edges.map((ed) => `${ed.from}|${ed.relation}|${ed.to}`),
      ),
    ).size;
    expect(result.nodesUpserted).toBe(totalNodes);
    expect(result.edgesUpserted).toBe(totalEdges);

    const nodes = db.collection(collections.nodes);
    const relationships = db.collection(collections.relationships);

    const nodeCount = await nodes.countDocuments({
      'properties.code_root': fixturesRoot,
    });
    const edgeCount = await relationships.countDocuments({
      'properties.code_root': fixturesRoot,
    });
    expect(nodeCount).toBe(uniqueNodeIds);
    expect(edgeCount).toBe(uniqueEdgeKeys);

    // Ids carry the graphify: prefix; documents are tagged katra-code.
    const sampleNode = await nodes.findOne({
      id: { $regex: '^graphify:' },
      'properties.source_file': 'sample.ts',
    });
    expect(sampleNode).not.toBeNull();
    expect(sampleNode!.id).toMatch(/^graphify:/);
    expect(sampleNode!.source).toBe('katra-code');
    expect(sampleNode!.properties.code_root).toBe(fixturesRoot);
    expect(sampleNode!.properties.code_language).toBe('typescript');

    const sampleEdge = await relationships.findOne({
      id: { $regex: '^graphify:edge:' },
      'properties.source_file': 'sample.ts',
    });
    expect(sampleEdge).not.toBeNull();
    expect(sampleEdge!.id).toMatch(/^graphify:edge:/);
    expect(sampleEdge!.source).toBe('katra-code');
    expect(sampleEdge!.properties.code_root).toBe(fixturesRoot);

    // status() agrees with the stored fragment counts.
    const status = await sync.status(fixturesRoot);
    expect(status.nodeCount).toBe(nodeCount);
    expect(status.edgeCount).toBe(edgeCount);
    expect(status.lastSyncAt).toBeNull();

    // 4. Fabricate a deletion of a file that was just synced and re-sync.
    const deletion: ChangeSet = {
      added: [],
      modified: [],
      deleted: ['sample.ts'],
      unchanged: scanned
        .filter((f) => f.relPath !== 'sample.ts')
        .map((f) => f.relPath),
      total: scanned.length - 1,
    };
    const deletionResult = await sync.sync(fixturesRoot, deletion, new Map());

    expect(deletionResult.nodesRetracted).toBeGreaterThan(0);
    expect(deletionResult.edgesRetracted).toBeGreaterThan(0);
    expect(deletionResult.nodesUpserted).toBe(0);
    expect(deletionResult.edgesUpserted).toBe(0);

    // Full physical retraction: no sample.ts fragment remains...
    expect(
      await nodes.countDocuments({
        id: { $regex: '^graphify:' },
        'properties.code_root': fixturesRoot,
        'properties.source_file': 'sample.ts',
      }),
    ).toBe(0);
    expect(
      await relationships.countDocuments({
        id: { $regex: '^graphify:edge:' },
        'properties.code_root': fixturesRoot,
        'properties.source_file': 'sample.ts',
      }),
    ).toBe(0);

    // ...while every other file's fragment survives (including sample.py's
    // own symbols, which share no id with sample.ts).
    expect(
      await nodes.countDocuments({ 'properties.code_root': fixturesRoot }),
    ).toBeGreaterThan(0);
    expect(
      await nodes.countDocuments({
        'properties.code_root': fixturesRoot,
        'properties.source_file': 'widget.ts',
      }),
    ).toBeGreaterThan(0);
    expect(await nodes.findOne({ id: 'graphify:sample_main' })).not.toBeNull();
  });
});
