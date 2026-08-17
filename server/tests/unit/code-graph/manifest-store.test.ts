/**
 * Unit tests: ManifestStore (F1)
 *
 * Round-trips scan manifests through MongoDB using the shared test helpers
 * (test_-prefixed collection, cleanup in afterAll). When no MongoDB is
 * reachable (default URI or MONGODB_URI env), the suite is skipped so the
 * rest of the unit run stays green; run with MONGODB_URI set against a live
 * instance to exercise the full round-trip.
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
import { ManifestStore } from '../../../src/services/code-graph/manifest-store.js';

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

describe.skipIf(!mongoAvailable)('ManifestStore', () => {
  let store: ManifestStore;
  const collectionName = testCollection('code_scan_state');
  const root = resolve('/tmp/katra-f1-manifest-fixture-root');

  const state = (
    h: string,
    mtimeMs = 1000,
    size = 10,
  ): { mtimeMs: number; size: number; hash: string } => ({
    mtimeMs,
    size,
    hash: h,
  });

  beforeAll(async () => {
    const db = await getTestDB();
    store = new ManifestStore(db, collectionName);
    await cleanupTestData('code_scan_state');
  });

  afterAll(async () => {
    await cleanupTestData('code_scan_state');
    await closeTestDB();
  });

  it('returns null when no manifest was saved', async () => {
    expect(await store.loadManifest(root)).toBeNull();
  });

  it('round-trips a saved manifest with the documented document shape', async () => {
    const files = { 'src/a.ts': state('a'), 'src/b.ts': state('b') };
    await store.saveManifest(root, files);

    const loaded = await store.loadManifest(root);
    expect(loaded).not.toBeNull();
    expect(loaded!.root).toBe(root);
    expect(Date.parse(loaded!.updatedAt)).not.toBeNaN();
    expect(loaded!.files).toEqual(files);

    // Document id is sha256(resolve(root)) hex
    const expectedId = createHash('sha256').update(root).digest('hex');
    const db = await getTestDB();
    const doc = await db
      .collection(collectionName)
      .findOne({ _id: expectedId });
    expect(doc).not.toBeNull();
    expect(doc!.root).toBe(root);
    expect(doc!.updatedAt).toBe(loaded!.updatedAt);
    expect(doc!.files).toEqual(files);
  });

  it('upserts: a second save replaces the previous manifest without duplicates', async () => {
    const filesV2 = {
      'src/a.ts': state('a2', 2000, 20),
      'src/c.ts': state('c'),
    };
    await store.saveManifest(root, filesV2);

    const loaded = await store.loadManifest(root);
    expect(loaded!.files).toEqual(filesV2);
    expect(Object.keys(loaded!.files).sort()).toEqual(['src/a.ts', 'src/c.ts']);

    const db = await getTestDB();
    const count = await db.collection(collectionName).countDocuments({});
    expect(count).toBe(1);
  });

  it('keeps manifests for different roots in separate documents', async () => {
    const otherRoot = resolve('/tmp/katra-f1-manifest-fixture-other');
    await store.saveManifest(otherRoot, { 'x.py': state('x') });

    expect(await store.loadManifest(otherRoot)).toMatchObject({
      root: otherRoot,
    });
    expect((await store.loadManifest(root))!.files['src/a.ts'].hash).toBe('a2');

    const db = await getTestDB();
    const count = await db.collection(collectionName).countDocuments({});
    expect(count).toBe(2);
  });
});
