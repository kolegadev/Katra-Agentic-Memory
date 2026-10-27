/**
 * ITER-4 — the self-model is durable and identity-scoped.
 * Contract: CONTRACT-iter4-durable-self-model.md
 *
 * What is proved here, against the REAL service and the REAL MCP handlers:
 *
 *   A. beliefs — a belief written by one identity is invisible to another, a
 *      re-write never touches another identity's row, and no write path names
 *      the legacy identity-less value (`default`) any more;
 *   B. the dedupe migration — seeded duplicates collapse deterministically to
 *      one row per `{user_id, entity_name, proposition}`, the counts are
 *      returned and logged, the unique index is created only afterwards and a
 *      second run is a no-op that writes nothing;
 *   C. procedural patterns — rows recorded under one identity are readable
 *      after a restart and invisible to another identity, the unique triple is
 *      enforced (a repeat records an update, not a duplicate row), the cache
 *      hydrates from the store and never double counts;
 *   D. the MCP layer — `get_agent_beliefs` and `get_procedural_templates` are
 *      caller-pinned through `runWithCaller`, the way the transport runs every
 *      tool call;
 *   E. the flush path (regression) — a pending increment recorded before an
 *      identity was ever read is written as stored + pending (never over the
 *      stored total), a flush that ends with errors re-arms the debounced
 *      retry, a transient index-build failure is retried instead of memoised,
 *      and a cache reset whose flush failed keeps the pending observations.
 *
 * "Restart" is a real one: `loadProcess()` re-imports the module graph (so every
 * singleton, cache and memoised index check starts empty) against a given store.
 * A second process bound to the same store therefore has nothing in memory.
 * Data lives in the in-memory Mongo fake, which enforces the unique indexes the
 * migration installs.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/** The store every reloaded module graph binds to (see loadProcess). */
const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const BELIEFS = 'agent_beliefs';
const PATTERNS = 'procedural_patterns';
const UNIQUE_INDEX = 'user_entity_proposition_unique';

const untrustedA: CallerIdentity = { user_id: 'agent-a', trusted: false };
const untrustedB: CallerIdentity = { user_id: 'agent-b', trusted: false };
const trustedOperator: CallerIdentity = { user_id: 'operator', trusted: true };

type ServiceModule = typeof import('../../src/services/processing/self-model-service.js');
type TextContent = { type: string; text: string };

interface LoadedService {
  db: FakeDb;
  service: InstanceType<ServiceModule['SelfModelService']>;
  module: ServiceModule;
}

interface LoadedProcess extends LoadedService {
  /** The MCP layer of THIS module graph — same singletons as the service. */
  handleGetAgentBeliefs: (args: unknown) => Promise<TextContent[]>;
  handleGetProceduralTemplates: (args: unknown) => Promise<TextContent[]>;
  runDistillation: (options: {
    userId: string;
    minObservations?: number;
    autoSynthesize?: boolean;
  }) => Promise<any>;
  /** `runWithCaller` from THIS graph: the caller store the handlers read. */
  withCaller: <T>(caller: CallerIdentity, fn: () => Promise<T> | T) => Promise<T>;
}

/**
 * A fresh process. The module graph is re-imported (no in-memory state) against
 * the given store; pass an existing `FakeDb` to model a restart over the same
 * data.
 */
async function loadService(db: FakeDb = new FakeDb()): Promise<LoadedService> {
  holder.db = db;
  vi.resetModules();
  const module = (await import('../../src/services/processing/self-model-service.js')) as ServiceModule;
  return { db, service: module.SelfModelService.get_instance(), module };
}

async function loadProcess(db: FakeDb = new FakeDb()): Promise<LoadedProcess> {
  holder.db = db;
  vi.resetModules();
  const module = (await import('../../src/services/processing/self-model-service.js')) as ServiceModule;
  const mcp = await import('../../src/mcp-server.js');
  const distillation = await import('../../src/services/processing/operational-distillation-service.js');
  const caller = await import('../../src/utils/caller-identity.js');
  return {
    db,
    service: module.SelfModelService.get_instance(),
    module,
    handleGetAgentBeliefs: mcp.handleGetAgentBeliefs,
    handleGetProceduralTemplates: mcp.handleGetProceduralTemplates,
    runDistillation: (options) =>
      distillation.OperationalDistillationService.get_instance().runDistillation(options),
    withCaller: caller.runWithCaller,
  };
}

/** A process whose database connection is gone (offline mode). */
async function loadOfflineService(): Promise<LoadedService> {
  holder.db = null;
  vi.resetModules();
  const module = (await import('../../src/services/processing/self-model-service.js')) as ServiceModule;
  return { db: new FakeDb(), service: module.SelfModelService.get_instance(), module };
}

/** Call a handler the way the transport does: inside runWithCaller(). */
async function callTool(
  process: LoadedProcess,
  handler: (args: unknown) => Promise<TextContent[]>,
  args: unknown,
  caller: CallerIdentity,
): Promise<string> {
  const result = await process.withCaller(caller, () => handler(args));
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('text');
  return result[0].text;
}

function seedBeliefs(db: FakeDb, docs: Record<string, any>[]): void {
  db.collection(BELIEFS).docs.push(...docs.map((doc) => structuredClone(doc)));
}

/** Real time, used by the debounce tests (the flush delay is 250 ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait (real time) until `check()` holds, or give up after `timeoutMs`. Used by
 * the debounce tests so a slow machine cannot turn a landed observation into a
 * spurious failure — and so a missing retry still fails, just after the timeout.
 */
async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(25);
}

function beliefRowIds(db: FakeDb): string[] {
  return db.collection(BELIEFS).docs.map((doc) => doc._id).sort();
}

describe('ITER-4 A — beliefs are identity-scoped', () => {
  it('a belief written by one identity is invisible to another', async () => {
    const { db, service } = await loadService();

    await service.trackBelief('agent-a', 'alice', 'prefers brevity', 0.9, 'observation');

    expect(await service.getAgentBeliefs('agent-b', 'alice')).toEqual([]);
    const own = await service.getAgentBeliefs('agent-a', 'alice');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ proposition: 'prefers brevity', confidence: 0.9, source: 'observation' });

    // Exactly one row, carrying the identity that wrote it.
    const rows = db.collection(BELIEFS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('agent-a');
  });

  it('the same proposition is one row per identity, and a re-write by A leaves B untouched', async () => {
    const { db, service } = await loadService();

    await service.trackBelief('agent-a', 'alice', 'is reliable', 0.4, 'inference');
    await service.trackBelief('agent-b', 'alice', 'is reliable', 0.7, 'inference');
    // A's upsert must match A's row (user_id is part of the filter) …
    await service.trackBelief('agent-a', 'alice', 'is reliable', 0.95, 're-observation');

    const a = await service.getAgentBeliefs('agent-a', 'alice');
    const b = await service.getAgentBeliefs('agent-b', 'alice');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].confidence).toBeCloseTo(0.95);
    expect(b[0].confidence).toBeCloseTo(0.7);
    expect(b[0].source).toBe('inference');
    expect(db.collection(BELIEFS).docs).toHaveLength(2);
  });

  it('a write without an identity is refused, not attributed to anyone', async () => {
    const { db, service } = await loadService();

    await expect(service.trackBelief('', 'alice', 'knows python', 0.5, 'test')).rejects.toThrow(/requires a user_id/);
    await expect(service.trackBelief('   ', 'alice', 'knows python', 0.5, 'test')).rejects.toThrow(/requires a user_id/);
    await expect(service.getAgentBeliefs('', 'alice')).rejects.toThrow(/requires a user_id/);
    expect(db.collection(BELIEFS).docs).toEqual([]);
  });

  it('no write path names the legacy identity-less value (source-level)', () => {
    for (const file of ['self-model-service.ts', 'self-model-collections.ts']) {
      const source = readFileSync(
        new URL(`../../src/services/processing/${file}`, import.meta.url),
        'utf8',
      );
      expect(source, `${file} still names the legacy identity-less value`).not.toContain("'default'");
      expect(source, `${file} still names the legacy identity-less value`).not.toContain('"default"');
      expect(source, `${file} must never write a literal user_id`).not.toMatch(/user_id:\s*['"][^'"]+['"]/);
    }

    // The MCP layer only passes resolved identities — never a literal one.
    const mcp = readFileSync(new URL('../../src/mcp-server.ts', import.meta.url), 'utf8');
    expect(mcp).not.toMatch(/user_id:\s*['"]default['"]/);
    expect(mcp).toMatch(/const patternIdentity = resolveUserId\(/);
  });
});

describe('ITER-4 B — the dedupe migration', () => {
  /** Three duplicate groups plus lone rows, seeded by hand. */
  function seedDuplicateSet(db: FakeDb): void {
    const at = (iso: string) => new Date(iso);
    seedBeliefs(db, [
      // group 1: highest confidence wins (two rows tie there, the newer one wins)
      { _id: 'g1-old', user_id: 'default', entity_name: 'alice', proposition: 'prefers brevity', confidence: 0.4, last_updated: at('2026-08-01T00:00:00Z'), source: 'legacy-low' },
      { _id: 'g1-tie-a', user_id: 'default', entity_name: 'alice', proposition: 'prefers brevity', confidence: 0.9, last_updated: at('2026-08-02T00:00:00Z'), source: 'legacy-tie-a' },
      { _id: 'g1-winner', user_id: 'default', entity_name: 'alice', proposition: 'prefers brevity', confidence: 0.9, last_updated: at('2026-08-03T00:00:00Z'), source: 'legacy-tie-b' },
      // group 2: confidence AND timestamp tie — the lowest _id wins
      { _id: 'g2-b', user_id: 'default', entity_name: 'bob', proposition: 'is reliable', confidence: 0.5, last_updated: at('2026-08-01T00:00:00Z'), source: 'legacy' },
      { _id: 'g2-a', user_id: 'default', entity_name: 'bob', proposition: 'is reliable', confidence: 0.5, last_updated: at('2026-08-01T00:00:00Z'), source: 'legacy' },
      { _id: 'g2-c', user_id: 'default', entity_name: 'bob', proposition: 'is reliable', confidence: 0.5, last_updated: at('2026-08-01T00:00:00Z'), source: 'legacy' },
      // group 3: confidence beats a newer timestamp
      { _id: 'g3-confident', user_id: 'katra', entity_name: 'carol', proposition: 'ships on fridays', confidence: 0.8, last_updated: at('2026-08-01T00:00:00Z'), source: 'observed' },
      { _id: 'g3-newer', user_id: 'katra', entity_name: 'carol', proposition: 'ships on fridays', confidence: 0.5, last_updated: at('2026-09-01T00:00:00Z'), source: 'guessed' },
      // lone rows: no duplicate key, so they stay exactly as they are
      { _id: 'lone-1', user_id: 'default', entity_name: 'dave', proposition: 'is on holiday', confidence: 0.3, last_updated: at('2026-08-01T00:00:00Z'), source: 'legacy' },
      { _id: 'lone-2', user_id: 'katra', entity_name: 'alice', proposition: 'prefers brevity', confidence: 0.6, last_updated: at('2026-08-04T00:00:00Z'), source: 'identity-row' },
    ]);
  }

  it('collapses each key group deterministically and creates the unique index afterwards', async () => {
    const { db, service } = await loadService();
    seedDuplicateSet(db);
    const lines: string[] = [];

    const result = await service.dedupeAgentBeliefs((message) => lines.push(message));

    // Counts: 5 key groups, 3 of them duplicated, 5 surplus documents, all removed.
    expect(result.groups_scanned).toBe(5);
    expect(result.duplicate_groups).toBe(3);
    expect(result.duplicates_found).toBe(5);
    expect(result.documents_removed).toBe(5);
    expect(result.groups_touched).toBe(3);
    expect(result.documents_without_id).toBe(0);
    expect(result.errors).toEqual([]);

    // One row per key, and the winner of each group is the deterministic one:
    // highest confidence, then newest last_updated, then lowest _id.
    expect(beliefRowIds(db)).toEqual(['g1-winner', 'g2-a', 'g3-confident', 'lone-1', 'lone-2']);

    // Rows that were alone are untouched — the legacy ones are not re-attributed.
    expect(db.collection(BELIEFS).docs.find((doc) => doc._id === 'lone-1')).toMatchObject({
      user_id: 'default',
      source: 'legacy',
      proposition: 'is on holiday',
    });

    // The counts are surfaced in the log as well as in the return value.
    const logged = lines.join('\n');
    expect(logged).toContain('removed 5 document(s) across 3 group(s)');
    expect(logged).toContain('5 duplicate document(s)');
    expect(logged).toContain(UNIQUE_INDEX);

    // …and only then is the unique index created.
    expect(result.index_created).toBe(true);
    expect(result.index_present).toBe(true);
    expect(await db.collection(BELIEFS).indexes()).toContainEqual(
      expect.objectContaining({
        name: UNIQUE_INDEX,
        key: { user_id: 1, entity_name: 1, proposition: 1 },
        unique: true,
      }),
    );
  });

  it('a unique index cannot be built over the duplicates — the collapse is what makes it possible', async () => {
    const { db, service } = await loadService();
    seedDuplicateSet(db);
    const collection = db.collection(BELIEFS);

    // Control: the raw index create fails while duplicates are present …
    await expect(
      collection.createIndex(
        { user_id: 1, entity_name: 1, proposition: 1 },
        { unique: true, name: UNIQUE_INDEX },
      ),
    ).rejects.toThrow(/E11000/);
    expect(await collection.indexes()).toEqual([]);

    // … the migration collapses first and creates it afterwards.
    const result = await service.dedupeAgentBeliefs(() => {});
    expect(result.errors).toEqual([]);
    expect(result.index_created).toBe(true);

    // With the unique key in place a duplicate can no longer be inserted.
    await expect(
      collection.insertOne({
        _id: 'g1-copy',
        user_id: 'default',
        entity_name: 'alice',
        proposition: 'prefers brevity',
        confidence: 1,
      }),
    ).rejects.toThrow(/E11000/);
  });

  it('a second run reports zeros and writes nothing', async () => {
    const { db, service } = await loadService();
    seedDuplicateSet(db);

    const first = await service.dedupeAgentBeliefs(() => {});
    expect(first.documents_removed).toBe(5);

    const docsAfterFirst = structuredClone(db.collection(BELIEFS).docs);
    const indexesAfterFirst = structuredClone(await db.collection(BELIEFS).indexes());
    const lines: string[] = [];
    const second = await service.dedupeAgentBeliefs((message) => lines.push(message));

    expect(second).toMatchObject({
      duplicate_groups: 0,
      duplicates_found: 0,
      documents_removed: 0,
      groups_touched: 0,
      documents_without_id: 0,
      index_created: false,
      index_replaced: false,
      index_present: true,
      errors: [],
    });
    // `groups_scanned` still counts the surviving key groups — a read, not a write.
    expect(second.groups_scanned).toBe(5);

    expect(db.collection(BELIEFS).docs).toEqual(docsAfterFirst);
    expect(await db.collection(BELIEFS).indexes()).toEqual(indexesAfterFirst);
    expect(lines.join('\n')).toContain('removed 0 document(s) across 0 group(s)');
  });

  it('is a no-op on an empty store — and still installs the index', async () => {
    const { db, service } = await loadService();

    const result = await service.dedupeAgentBeliefs(() => {});

    expect(result).toMatchObject({
      groups_scanned: 0,
      duplicate_groups: 0,
      documents_removed: 0,
      groups_touched: 0,
      index_created: true,
      index_present: true,
      errors: [],
    });
    expect(db.collection(BELIEFS).docs).toEqual([]);
  });

  it('the boot migration path collapses the duplicates and installs both unique indexes', async () => {
    const { db } = await loadService();
    seedDuplicateSet(db);
    const migrations = await import('../../src/database/migrations.js');

    // The index initialiser is chatty (it drops and recreates every declared
    // index); the interesting part is the recorded outcome.
    const quiet = ['log', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation(() => {}),
    );
    try {
      await migrations.runDatabaseMigrations(db.asDb());
    } finally {
      for (const spy of quiet) spy.mockRestore();
    }

    // The dedupe ran BEFORE index initialisation, so the unique index built
    // successfully and the collapse is the deterministic one.
    expect(beliefRowIds(db)).toEqual(['g1-winner', 'g2-a', 'g3-confident', 'lone-1', 'lone-2']);
    expect(await db.collection(BELIEFS).indexes()).toContainEqual(
      expect.objectContaining({ name: UNIQUE_INDEX, unique: true }),
    );
    expect(await db.collection(PATTERNS).indexes()).toContainEqual(
      expect.objectContaining({ name: 'user_tool_shape_unique', unique: true }),
    );
  });

  it('reports an incomplete collapse instead of building the index over it', async () => {
    const { db, service } = await loadService();
    seedDuplicateSet(db);
    const collection = db.collection(BELIEFS);
    collection.deleteMany = async () => {
      throw new Error('write concern not satisfied');
    };

    const result = await service.dedupeAgentBeliefs(() => {});

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/write concern not satisfied/);
    expect(result.documents_removed).toBe(0);
    expect(result.groups_touched).toBe(0);
    expect(result.index_created).toBe(false);
    expect(result.index_present).toBe(false);
    // Nothing was half-collapsed silently: every row is still there.
    expect(collection.docs).toHaveLength(10);
  });

  it('replaces a same-named index that does not enforce the unique key', async () => {
    const { db, service } = await loadService();
    seedDuplicateSet(db);
    const collection = db.collection(BELIEFS);

    // A pre-existing look-alike: the declared NAME and key, but not unique.
    // Accepting it as "the index is present" is what left duplicates insertable.
    await collection.createIndex(
      { user_id: 1, entity_name: 1, proposition: 1 },
      { name: UNIQUE_INDEX },
    );

    // MongoDB enforces a unique index only when one actually exists, so model
    // that: while the look-alike stands, a duplicate goes straight in.
    const insert = collection.insertOne.bind(collection);
    collection.insertOne = async (doc: Record<string, any>) => {
      const enforcing = (await collection.indexes()).some(
        (index) =>
          index.unique === true &&
          JSON.stringify(index.key) ===
            JSON.stringify({ user_id: 1, entity_name: 1, proposition: 1 }),
      );
      if (enforcing) return insert(doc);
      collection.docs.push(structuredClone(doc));
      return { acknowledged: true, insertedId: doc._id ?? 'x' };
    };

    const duplicate = {
      _id: 'dup-1',
      user_id: 'default',
      entity_name: 'alice',
      proposition: 'prefers brevity',
      confidence: 0.2,
    };
    expect((await collection.insertOne(duplicate)).acknowledged).toBe(true);

    const lines: string[] = [];
    const result = await service.dedupeAgentBeliefs((message) => lines.push(message));

    // The look-alike was not mistaken for the constraint: it was dropped,
    // reported in the counts and named in the log, and the real index was built.
    expect(result.index_replaced).toBe(true);
    expect(result.index_created).toBe(true);
    expect(result.index_present).toBe(true);
    expect(result.errors).toEqual([]);
    const logged = lines.join('\n');
    expect(logged).toMatch(/dropped/);
    expect(logged).toContain(UNIQUE_INDEX);

    expect((await collection.indexes()).filter((index) => index.name === UNIQUE_INDEX)).toEqual([
      expect.objectContaining({
        name: UNIQUE_INDEX,
        unique: true,
        key: { user_id: 1, entity_name: 1, proposition: 1 },
      }),
    ]);

    // The collapse still happened, and with the real index in place the same
    // duplicate is now refused.
    expect(beliefRowIds(db)).toEqual(['g1-winner', 'g2-a', 'g3-confident', 'lone-1', 'lone-2']);
    await expect(collection.insertOne({ ...duplicate, _id: 'dup-2' })).rejects.toThrow(/E11000/);
  });
});

describe('ITER-4 B2 — index validation is structural, not name-only', () => {
  const TRIPLE = { user_id: 1, entity_name: 1, proposition: 1 };

  it('validateIndexes does not accept a look-alike for a declared unique index', async () => {
    const db = new FakeDb();
    const { IndexManager } = await import('../../src/database/index-management.js');
    const beliefs = db.collection(BELIEFS);
    const missing = async () =>
      (await new IndexManager(db.asDb()).validateIndexes()).missing_indexes;

    // The declared name on a non-unique index: name-only logic called this
    // present and skipped the repair.
    await beliefs.createIndex({ ...TRIPLE }, { name: UNIQUE_INDEX });
    expect(await missing()).toContainEqual({ collection: BELIEFS, index: UNIQUE_INDEX });

    // The declared name, unique, but keyed on something else — not the constraint.
    await beliefs.createIndex({ user_id: 1 }, { name: UNIQUE_INDEX, unique: true });
    expect(await missing()).toContainEqual({ collection: BELIEFS, index: UNIQUE_INDEX });

    // Control: name + unique + the exact key satisfies the declaration …
    await beliefs.createIndex({ ...TRIPLE }, { name: UNIQUE_INDEX, unique: true });
    expect(await missing()).not.toContainEqual({ collection: BELIEFS, index: UNIQUE_INDEX });

    // … and non-unique declarations keep their name-only check.
    await beliefs.createIndex(
      { user_id: 1, entity_name: 1, confidence: -1 },
      { name: 'user_entity_confidence' },
    );
    expect(await missing()).not.toContainEqual({
      collection: BELIEFS,
      index: 'user_entity_confidence',
    });
  });

  it('the boot initialiser repairs a non-unique look-alike instead of accepting it', async () => {
    const db = new FakeDb();
    const { IndexManager, MEMORY_SYSTEM_INDEXES, initializeMemorySystemIndexes } = await import(
      '../../src/database/index-management.js'
    );

    // Every declared index in place, so validation has only ONE thing to
    // complain about: the agent_beliefs unique key is a non-unique look-alike.
    for (const [name, definitions] of Object.entries(MEMORY_SYSTEM_INDEXES)) {
      for (const definition of definitions) {
        await db.collection(name).createIndex(definition.keys, definition.options);
      }
    }
    const beliefs = db.collection(BELIEFS);
    await beliefs.createIndex({ ...TRIPLE }, { name: UNIQUE_INDEX });
    expect((await new IndexManager(db.asDb()).validateIndexes()).valid).toBe(false);

    const quiet = ['log', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation(() => {}),
    );
    try {
      await initializeMemorySystemIndexes(db.asDb());
    } finally {
      for (const spy of quiet) spy.mockRestore();
    }

    // The look-alike is gone and the declared constraint is what is left.
    expect((await beliefs.indexes()).filter((index) => index.name === UNIQUE_INDEX)).toEqual([
      expect.objectContaining({ name: UNIQUE_INDEX, unique: true, key: { ...TRIPLE } }),
    ]);
  });
});

describe('ITER-4 C — procedural patterns are durable and per identity', () => {
  const PATTERN_SHAPE = { query: 'a topic', limit: 3 };
  const PATTERN_KEYS = '["limit","query"]';

  it('rows recorded under A are readable after a restart and invisible to B', async () => {
    const first = await loadProcess();
    for (let i = 0; i < 5; i++) {
      first.service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, i !== 4);
    }

    const flushed = await first.service.flushProceduralPatterns();
    expect(flushed).toEqual({ patterns_written: 1, errors: [] });

    const rows = first.db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'agent-a',
      tool_name: 'search_memories',
      frequency: 5,
      successes: 4,
      shape_keys: PATTERN_KEYS,
    });
    expect(rows[0].input_shape).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].avg_success).toBeCloseTo(0.8);

    // Restart: a fresh process over the same store starts with an empty cache.
    const restarted = await loadProcess(first.db);

    expect(await restarted.service.getProceduralTemplates('agent-b')).toEqual([]);
    expect(await restarted.service.getProceduralTemplateCount('agent-b')).toBe(0);
    expect(await restarted.service.getProceduralPatternCount('agent-b')).toBe(0);

    expect(await restarted.service.getProceduralTemplates('agent-a')).toEqual([
      { toolName: 'search_memories', inputShape: PATTERN_KEYS, frequency: 5, avgSuccess: 0.8 },
    ]);
    expect(await restarted.service.getProceduralPatternCount('agent-a')).toBe(1);
  });

  it('the unique triple is enforced: a repeated pattern updates its row instead of duplicating it', async () => {
    const { db, service } = await loadService();

    for (let i = 0; i < 6; i++) service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    await service.flushProceduralPatterns();

    const rows = db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ frequency: 6, successes: 6, avg_success: 1 });

    await expect(
      db.collection(PATTERNS).insertOne({
        user_id: 'agent-a',
        tool_name: 'search_memories',
        input_shape: rows[0].input_shape,
        frequency: 1,
      }),
    ).rejects.toThrow(/E11000/);

    // The same tool under another identity is a different row, not a collision.
    for (let i = 0; i < 2; i++) service.recordToolPattern('agent-b', 'search_memories', PATTERN_SHAPE, false);
    await service.flushProceduralPatterns();

    expect(db.collection(PATTERNS).docs).toHaveLength(2);
    expect(await service.getProceduralTemplates('agent-a')).toEqual([
      { toolName: 'search_memories', inputShape: PATTERN_KEYS, frequency: 6, avgSuccess: 1 },
    ]);
    expect(await service.getProceduralTemplateCount('agent-b')).toBe(0);
    expect(await service.getProceduralPatternCount('agent-b')).toBe(1);
  });

  it('hydration adds only the increments that are still pending (no double counting)', async () => {
    const first = await loadProcess();
    for (let i = 0; i < 5; i++) first.service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    await first.service.flushProceduralPatterns();

    const restarted = await loadProcess(first.db);
    // A write recorded before this process' first read is still pending …
    restarted.service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    expect((await restarted.service.getProceduralTemplates('agent-a'))[0].frequency).toBe(6);
    // … and reading again must not count it twice.
    expect((await restarted.service.getProceduralTemplates('agent-a'))[0].frequency).toBe(6);

    await restarted.service.flushProceduralPatterns();
    expect(restarted.db.collection(PATTERNS).docs[0]).toMatchObject({ frequency: 6, successes: 6 });
    expect((await restarted.service.getProceduralTemplates('agent-a'))[0].frequency).toBe(6);
  });

  it('the store is the truth: a row changed behind the process is what the next read returns', async () => {
    const first = await loadProcess();
    first.service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    await first.service.flushProceduralPatterns();

    const restarted = await loadProcess(first.db);
    restarted.db.collection(PATTERNS).docs[0] = {
      ...restarted.db.collection(PATTERNS).docs[0],
      frequency: 12,
      successes: 9,
      avg_success: 0.75,
    };

    expect(await restarted.service.getProceduralTemplates('agent-a')).toEqual([
      { toolName: 'search_memories', inputShape: PATTERN_KEYS, frequency: 12, avgSuccess: 0.75 },
    ]);
  });

  it('the cache is not the truth: clearing it re-reads the store (shutdown path)', async () => {
    const { db, service } = await loadService();
    for (let i = 0; i < 5; i++) service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);

    const flushed = await service.resetProceduralCache();
    expect(flushed).toEqual({ patterns_written: 1, errors: [], cleared: true });
    expect(db.collection(PATTERNS).docs).toHaveLength(1);

    expect(await service.getProceduralTemplates('agent-a')).toEqual([
      { toolName: 'search_memories', inputShape: PATTERN_KEYS, frequency: 5, avgSuccess: 1 },
    ]);
  });

  it('flushing writes nothing when nothing is pending, and keeps observations when the store is gone', async () => {
    const { db, service } = await loadService();
    expect(await service.flushProceduralPatterns()).toEqual({ patterns_written: 0, errors: [] });
    expect(db.collection(PATTERNS).docs).toEqual([]);

    const offline = await loadOfflineService();
    offline.service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    const offlineFlush = await offline.service.flushProceduralPatterns();

    expect(offlineFlush.patterns_written).toBe(0);
    expect(offlineFlush.errors.join(' ')).toMatch(/database not connected/);
    // The observation is not lost — it stays in the cache for a later flush.
    expect(await offline.service.getProceduralPatternCount('agent-a')).toBe(1);
  });

  it('refuses to record or read patterns without an identity', async () => {
    const { db, service } = await loadService();

    expect(() => service.recordToolPattern('', 'search_memories', PATTERN_SHAPE, true)).toThrow(/requires a user_id/);
    await expect(service.getProceduralTemplates('  ')).rejects.toThrow(/requires a user_id/);
    expect(db.collection(PATTERNS).docs).toEqual([]);
  });

  it('never rejects when the store itself throws, and a later flush lands the observations', async () => {
    const db = new FakeDb();
    const reach = db.collection.bind(db);
    let storeDown = true;
    // A store whose `collection()` throws synchronously: a failure no per-row
    // guard can see, because it happens before any row is touched.
    db.collection = ((name: string) => {
      if (storeDown && name === PATTERNS) throw new Error('store unavailable: collection() threw');
      return reach(name);
    }) as typeof db.collection;

    const { service } = await loadService(db);
    for (let i = 0; i < 3; i++) {
      service.recordToolPattern('agent-a', 'search_memories', PATTERN_SHAPE, true);
    }

    const failed = await service.flushProceduralPatterns();

    // It resolves, the failure is surfaced, nothing is written …
    expect(failed.patterns_written).toBe(0);
    expect(failed.errors.join(' ')).toMatch(/store unavailable/);
    expect(reach(PATTERNS).docs).toEqual([]);
    // … and the observation is retained rather than dropped.
    expect(await service.getProceduralPatternCount('agent-a')).toBe(1);

    // The store comes back: the still-pending increments land on the retry.
    storeDown = false;
    const retried = await service.flushProceduralPatterns();
    expect(retried).toEqual({ patterns_written: 1, errors: [] });

    const rows = reach(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: 'agent-a',
      tool_name: 'search_memories',
      frequency: 3,
      successes: 3,
      avg_success: 1,
    });
    expect(await service.getProceduralTemplates('agent-a')).toHaveLength(0); // below the threshold
  });

  it('distinct {identity, tool, shape} triples never share a cache bucket', async () => {
    const { db, service } = await loadService();
    const shape = { query: 'search' };

    // Constructed collision: joined with a separator these two triples encode
    // identically (`a\0b\0c\0<shapeHash>`), which merged two identities' and two
    // tools' counters into one bucket. Length-prefixed segments cannot collide.
    service.recordToolPattern('a\0b', 'c', shape, true);
    service.recordToolPattern('a', 'b\0c', shape, true);

    expect(await service.getProceduralPatternCount('a\0b')).toBe(1);
    expect(await service.getProceduralPatternCount('a')).toBe(1);

    const flushed = await service.flushProceduralPatterns();
    expect(flushed.errors).toEqual([]);

    const rows = db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.user_id}|${row.tool_name}`).sort()).toEqual(
      ['a|b\0c', 'a\0b|c'].sort(),
    );
    expect(rows.map((row) => row.frequency)).toEqual([1, 1]);

    // Control: the SAME triple still shares exactly one bucket (and one row).
    service.recordToolPattern('a\0b', 'c', shape, true);
    expect(await service.getProceduralPatternCount('a\0b')).toBe(1);
    expect((await service.getProceduralPatterns('a\0b'))[0].frequency).toBe(2);

    await service.flushProceduralPatterns();
    expect(db.collection(PATTERNS).docs).toHaveLength(2);
    expect(db.collection(PATTERNS).docs.find((row) => row.user_id === 'a\0b')).toMatchObject({
      tool_name: 'c',
      frequency: 2,
    });
  });

  it('registers the collection indexes lazily, with the identity leading every key', async () => {
    const { db, service } = await loadService();
    expect(await db.collection(PATTERNS).indexes()).toEqual([]);

    await service.getProceduralTemplates('agent-a');

    const indexes = await db.collection(PATTERNS).indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'user_tool_shape_unique',
        key: { user_id: 1, tool_name: 1, input_shape: 1 },
        unique: true,
      }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ name: 'user_last_seen', key: { user_id: 1, last_seen: -1 } }),
    );
  });

  it('the distillation service reads patterns through the identity-scoped API', async () => {
    const process = await loadProcess();
    for (let i = 0; i < 4; i++) {
      process.service.recordToolPattern('agent-a', 'search_memories', { query: 'x' }, true);
      process.service.recordToolPattern('agent-a', 'store_memory', { text: 'x' }, true);
    }

    const spy = vi.spyOn(process.service, 'getProceduralPatterns');
    const result = await process.runDistillation({ userId: 'agent-a', minObservations: 3, autoSynthesize: false });

    expect(result.errors).toEqual([]);
    // Every read the pipeline made was for the identity it was asked about.
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.map((call) => call[0])).toEqual(
      spy.mock.calls.map(() => 'agent-a'),
    );
    expect(spy).toHaveBeenCalledWith('agent-a', 5); // the templates read
    expect(spy).toHaveBeenCalledWith('agent-a', 3); // the internal raw-pattern read

    const other = await process.runDistillation({ userId: 'agent-b', minObservations: 3, autoSynthesize: false });
    expect(other.errors).toEqual([]);
    expect(spy.mock.calls.slice(-2).map((call) => call[0])).toEqual(['agent-b', 'agent-b']);
  });

  it('the distillation outcome depends on the identity\'s own patterns (executed end to end)', async () => {
    const first = await loadProcess();
    for (let i = 0; i < 4; i++) {
      first.service.recordToolPattern('agent-a', 'search_memories', { query: 'x' }, true);
      first.service.recordToolPattern('agent-a', 'store_memory', { text: 'x' }, true);
    }
    seedToolCallSessions(first.db, ['sess-1', 'sess-2', 'sess-3']);

    const asA = await first.runDistillation({ userId: 'agent-a', minObservations: 3, autoSynthesize: false });
    const candidateA = asA.candidates.find((c: any) => c.name === 'search-memories-store-memory');
    expect(candidateA).toBeTruthy();
    expect(candidateA.observed_sequence).toEqual(['search_memories', 'store_memory']);
    expect(candidateA.observation_count).toBe(3);
    // A's own patterns are 100% successful, so every observation counts as a success.
    expect(candidateA.success_count).toBe(3);

    // A second process: the same store, but agent-b owns no patterns at all, so
    // the pipeline falls back to its neutral 0.5 rate — A's patterns are invisible.
    const second = await loadProcess(first.db);
    const asB = await second.runDistillation({ userId: 'agent-b', minObservations: 3, autoSynthesize: false });
    const candidateB = asB.candidates.find((c: any) => c.name === 'search-memories-store-memory');
    expect(candidateB).toBeTruthy();
    expect(candidateB.observation_count).toBe(3);
    expect(candidateB.success_count).toBe(2);
  });

  it('the distillation service no longer reaches into the private pattern cache', () => {
    const source = readFileSync(
      new URL('../../src/services/processing/operational-distillation-service.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/proceduralPatterns/);
    expect(source).toContain('getProceduralPatterns(');
  });
});

describe('ITER-4 C2 — the flush path cannot lose observations (regression)', () => {
  const SHAPE = { query: 'a topic', limit: 3 };
  const KEYS = '["limit","query"]';
  /** Comfortably past `PROCEDURAL_FLUSH_DELAY_MS` (250 ms). */
  const PAST_DEBOUNCE_MS = 400;

  /** Seed ONE stored row for `agent-a`, the honest way: record it and flush. */
  async function seedStoredRow(db: FakeDb, times: number): Promise<any> {
    const seed = await loadProcess(db);
    for (let i = 0; i < times; i++) {
      seed.service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);
    }
    const flushed = await seed.service.flushProceduralPatterns();
    expect(flushed.errors).toEqual([]);
    const rows = db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'agent-a', frequency: times, successes: times });
    return rows[0];
  }

  it('a record made before the identity was ever read lands the true total on the FIRST flush', async () => {
    const db = new FakeDb();
    const stored = await seedStoredRow(db, 3);

    // A fresh process: one observation recorded BEFORE this identity has ever
    // been read — the true total is 3 stored + 1 = 4.
    const second = await loadProcess(db);
    second.service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);

    const flushed = await second.service.flushProceduralPatterns();
    expect(flushed.errors).toEqual([]);
    expect(flushed.patterns_written).toBe(1);

    // The single flush must write the stored + pending total. The pre-fix code
    // flushed a snapshot taken before hydration, so the stored row's frequency
    // went 3 → 1: three observations lost for good.
    const rows = db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0].input_shape).toBe(stored.input_shape);
    expect(rows[0]).toMatchObject({ frequency: 4, successes: 4, avg_success: 1 });

    // A fresh process reads the true total back … (4 is below the habitual
    // threshold, so read the raw patterns, not the templates)
    const third = await loadProcess(db);
    expect(await third.service.getProceduralPatterns('agent-a')).toEqual([
      expect.objectContaining({
        toolName: 'search_memories',
        inputShape: KEYS,
        frequency: 4,
        successes: 4,
        avgSuccess: 1,
      }),
    ]);
    // … and the identity that owns nothing still sees nothing.
    expect(await third.service.getProceduralPatterns('agent-b')).toEqual([]);
  });

  it('the debounce alone lands the true total over an existing row (no explicit flush)', async () => {
    const db = new FakeDb();
    await seedStoredRow(db, 3);

    // Real timers here on purpose: this is the debounce as production runs it.
    const second = await loadProcess(db);
    second.service.recordToolPattern('agent-a', 'search_memories', SHAPE, false);

    // No explicit flush anywhere: the debounced write is what must land it.
    // Polling keeps a slow machine from turning a landed write into a failure;
    // a wrong write (the pre-fix `frequency: 1`) still fails.
    await waitFor(() => db.collection(PATTERNS).docs[0]?.frequency === 4, PAST_DEBOUNCE_MS * 5);

    const rows = db.collection(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ frequency: 4, successes: 3 });
    expect(rows[0].avg_success).toBeCloseTo(0.75);

    const third = await loadProcess(db);
    expect(await third.service.getProceduralPatterns('agent-a')).toEqual([
      expect.objectContaining({ frequency: 4, successes: 3, avgSuccess: 0.75 }),
    ]);
  });

  it('resetProceduralCache over an existing row also writes the true total', async () => {
    const db = new FakeDb();
    await seedStoredRow(db, 3);

    const second = await loadProcess(db);
    second.service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);

    const reset = await second.service.resetProceduralCache();
    expect(db.collection(PATTERNS).docs[0]).toMatchObject({ frequency: 4, successes: 4 });
    expect(reset.cleared).toBe(true);

    // The cleared cache re-hydrates the same total from the store.
    expect(await second.service.getProceduralPatterns('agent-a')).toEqual([
      expect.objectContaining({ frequency: 4, successes: 4 }),
    ]);
  });

  it('a flush that ends with errors re-arms the retry (no further record, no explicit call)', async () => {
    const db = new FakeDb();
    const reach = db.collection.bind(db);
    let storeDown = true;
    db.collection = ((name: string) => {
      if (storeDown && name === PATTERNS) throw new Error('store unavailable: collection() threw');
      return reach(name);
    }) as typeof db.collection;

    // Fake timers: whether a retry was armed is decided by the service, not by
    // how fast this machine runs the debounce.
    vi.useFakeTimers();
    try {
      const { service } = await loadService(db);
      for (let i = 0; i < 3; i++) {
        service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);
      }

      // The debounced attempt fails while the store is down, leaving everything
      // pending …
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
      expect(reach(PATTERNS).docs).toEqual([]);

      // … and the store comes back. Nothing else is called: the failed flush
      // must have re-armed the debounce for the observations to land.
      storeDown = false;
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);

      const rows = reach(PATTERNS).docs;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: 'agent-a',
        frequency: 3,
        successes: 3,
        avg_success: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicitly failed flush is re-armed too', async () => {
    const db = new FakeDb();
    const reach = db.collection.bind(db);
    let storeDown = true;
    db.collection = ((name: string) => {
      if (storeDown && name === PATTERNS) throw new Error('store unavailable: collection() threw');
      return reach(name);
    }) as typeof db.collection;

    vi.useFakeTimers();
    try {
      const { service } = await loadService(db);
      service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);

      // Drain the debounce record() scheduled, then fail explicitly.
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
      const failed = await service.flushProceduralPatterns();
      expect(failed.patterns_written).toBe(0);
      expect(failed.errors.length).toBeGreaterThan(0);
      expect(failed.errors.join(' ')).toMatch(/store unavailable/);

      storeDown = false;
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS * 2);

      const rows = reach(PATTERNS).docs;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: 'agent-a', frequency: 1, successes: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transient index-build failure is retried, not memoised', async () => {
    const { db, service } = await loadService();

    const patterns = db.collection(PATTERNS);
    const realCreateIndex = patterns.createIndex.bind(patterns);
    let attempts = 0;
    patterns.createIndex = (async (keys: any, opts?: any) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient index build failure');
      return realCreateIndex(keys, opts);
    }) as typeof patterns.createIndex;

    // First use: the unique-key build fails (its siblings still go through).
    expect(await service.getProceduralTemplates('agent-a')).toEqual([]);
    const afterFirst = attempts;
    expect(afterFirst).toBeGreaterThan(0);
    expect((await patterns.indexes()).map((index) => index.name)).not.toContain(
      'user_tool_shape_unique',
    );

    // Second use — another identity, so the guard is consulted again: the failed
    // build must be attempted again instead of staying memoised as "done".
    await service.getProceduralTemplates('agent-b');
    expect(attempts).toBeGreaterThan(afterFirst);
    expect((await patterns.indexes()).map((index) => index.name)).toContain(
      'user_tool_shape_unique',
    );
  });

  it('a cache reset whose flush failed keeps the pending observations and says so', async () => {
    const db = new FakeDb();
    const reach = db.collection.bind(db);
    let storeDown = true;
    db.collection = ((name: string) => {
      if (storeDown && name === PATTERNS) throw new Error('store unavailable: collection() threw');
      return reach(name);
    }) as typeof db.collection;

    const { service } = await loadService(db);
    for (let i = 0; i < 3; i++) {
      service.recordToolPattern('agent-a', 'search_memories', SHAPE, true);
    }

    const reset = await service.resetProceduralCache();
    expect(reset.cleared).toBe(false);
    expect(reset.patterns_written).toBe(0);
    expect(reset.errors.join(' ')).toMatch(/store unavailable/);

    // The observations exist nowhere else, so the cache must have been kept.
    expect(await service.getProceduralPatternCount('agent-a')).toBe(1);
    expect((await service.getProceduralPatterns('agent-a'))[0].frequency).toBe(3);

    // And they land with their true totals once the store is back.
    storeDown = false;
    const retried = await service.flushProceduralPatterns();
    expect(retried.errors).toEqual([]);

    const rows = reach(PATTERNS).docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'agent-a', frequency: 3, successes: 3, avg_success: 1 });
  });
});

describe('ITER-4 D — the MCP tools are caller-pinned', () => {
  it("an untrusted caller cannot read another identity's beliefs, but may read its own", async () => {
    const process = await loadProcess();
    await process.service.trackBelief('agent-b', 'alice', 'is the reviewer', 0.8, 'observation');

    const asA = await callTool(
      process,
      process.handleGetAgentBeliefs,
      { entity_name: 'alice', user_id: 'agent-b' },
      untrustedA,
    );
    expect(asA).toContain('No beliefs recorded for this entity');
    expect(asA).not.toContain('is the reviewer');

    await process.service.trackBelief('agent-a', 'alice', 'knows the codebase', 0.6, 'observation');
    const own = await callTool(
      process,
      process.handleGetAgentBeliefs,
      { entity_name: 'alice', user_id: 'agent-b' },
      untrustedA,
    );
    expect(own).toContain('knows the codebase');
    expect(own).not.toContain('is the reviewer');
  });

  it('a trusted caller may name another identity', async () => {
    const process = await loadProcess();
    await process.service.trackBelief('agent-b', 'alice', 'is the reviewer', 0.8, 'observation');

    const named = await callTool(
      process,
      process.handleGetAgentBeliefs,
      { entity_name: 'alice', user_id: 'agent-b' },
      trustedOperator,
    );

    expect(named).toContain('is the reviewer');
  });

  it("an untrusted caller cannot read another identity's procedural patterns", async () => {
    const process = await loadProcess();
    for (let i = 0; i < 5; i++) process.service.recordToolPattern('agent-a', 'tool_alpha', { a: 'x' }, true);
    for (let i = 0; i < 5; i++) process.service.recordToolPattern('agent-b', 'tool_beta', { b: 'y' }, true);

    const asA = await callTool(process, process.handleGetProceduralTemplates, { user_id: 'agent-b' }, untrustedA);
    expect(asA).toContain('tool_alpha');
    expect(asA).not.toContain('tool_beta');

    const asOperator = await callTool(
      process,
      process.handleGetProceduralTemplates,
      { user_id: 'agent-b' },
      trustedOperator,
    );
    expect(asOperator).toContain('tool_beta');
    expect(asOperator).not.toContain('tool_alpha');
  });

  it("a caller with no patterns of its own gets an empty result, not someone else's", async () => {
    const process = await loadProcess();
    for (let i = 0; i < 5; i++) process.service.recordToolPattern('agent-a', 'tool_alpha', { a: 'x' }, true);

    const asB = await callTool(process, process.handleGetProceduralTemplates, {}, untrustedB);
    expect(asB).toContain('No procedural templates cached yet');

    const asA = await callTool(process, process.handleGetProceduralTemplates, {}, untrustedA);
    expect(asA).toContain('tool_alpha');
  });

  it('the tool-outcome wrapper records under the caller-resolved identity (source-level)', () => {
    const source = readFileSync(new URL('../../src/mcp-server.ts', import.meta.url), 'utf8');

    // The wrapper resolves the identity through resolveUserId (never the raw
    // caller-supplied id) …
    expect(source).toMatch(/const patternIdentity = resolveUserId\(\(rawArgs as any\)\?\.user_id\);/);
    // … and both outcome paths (success and failure) record with it.
    const recorded = source.match(/recordToolPattern\(\s*\n\s*patternIdentity,/g) ?? [];
    expect(recorded).toHaveLength(2);
    expect(source).not.toMatch(/recordToolPattern\(\s*\n\s*name,/);
  });
});

/** Seed three sessions of `search_memories → store_memory`, as real calls look. */
function seedToolCallSessions(db: FakeDb, sessions: string[]): void {
  const events = db.collection('episodic_events');
  sessions.forEach((session, index) => {
    const base = new Date(`2026-09-0${index + 1}T00:00:00Z`).getTime();
    events.docs.push(
      {
        _id: `${session}-1`,
        user_id: 'agent-a',
        session_id: session,
        event_type: 'tool_call',
        tool_name: 'search_memories',
        timestamp: new Date(base),
      },
      {
        _id: `${session}-2`,
        user_id: 'agent-a',
        session_id: session,
        event_type: 'tool_call',
        tool_name: 'store_memory',
        timestamp: new Date(base + 60_000),
      },
    );
  });

  // The fake has no `$or` support (documented limitation), and the distillation
  // query is `$or: [event_type, content.role, content.message]`. Serve the seeded
  // events for any filter so the session grouping — not the fake — is exercised.
  const find = events.find.bind(events);
  events.find = ((_filter: Record<string, any>, opts?: any) => find({}, opts)) as typeof events.find;
}
