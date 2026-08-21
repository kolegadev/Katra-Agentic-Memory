/**
 * Unit tests: MCP tools for the native code graph (F4)
 *
 * Covers the zod input schemas, the structural wiring of the three tools in
 * mcp-server.ts (tool entries, handlers, dispatch cases), and — because
 * importing mcp-server.ts does NOT connect to MongoDB/Redis or start any
 * server (verified: connections and transports only exist inside functions)
 * — direct handler tests. The disconnected-guard tests run everywhere; the
 * full scan/sync/status flows run only when a MongoDB is reachable (same
 * skip pattern as the other code-graph suites).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import {
  ScanCodebaseInput,
  SyncCodeGraphInput,
  CodeGraphStatusInput,
} from '../../../src/services/code-graph/tool-schemas.js';
import { ManifestStore } from '../../../src/services/code-graph/manifest-store.js';
import { scanCodebase } from '../../../src/services/code-graph/codebase-scanner.js';
import {
  handleScanCodebase,
  handleSyncCodeGraph,
  handleCodeGraphStatus,
} from '../../../src/mcp-server.js';
import {
  close_connection,
  connect_to_mongodb,
  get_database,
  is_database_connected,
} from '../../../src/database/connection.js';
import { DEFAULT_USER_ID } from '../../../src/services/memory/memory-scope-service.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip DB-dependent tests when
// unavailable, so the unit run stays green without a MongoDB.
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

// ── Schema tests ───────────────────────────────────────────────────

describe('code-graph MCP tool input schemas', () => {
  it('accepts a valid root', () => {
    expect(ScanCodebaseInput.parse({ root: '/tmp/some/dir' })).toEqual({ root: '/tmp/some/dir' });
    expect(SyncCodeGraphInput.parse({ root: '/' })).toEqual({ root: '/' });
    expect(CodeGraphStatusInput.parse({ root: 'rel/path' })).toEqual({ root: 'rel/path' });
  });

  it('accepts an optional followSymlinks boolean', () => {
    expect(ScanCodebaseInput.parse({ root: '/x', followSymlinks: true })).toEqual({ root: '/x', followSymlinks: true });
    expect(ScanCodebaseInput.parse({ root: '/x', followSymlinks: false })).toEqual({ root: '/x', followSymlinks: false });
    expect(ScanCodebaseInput.parse({ root: '/x' })).toEqual({ root: '/x' });
  });

  it('rejects an empty root', () => {
    expect(() => ScanCodebaseInput.parse({ root: '' })).toThrow();
    expect(() => SyncCodeGraphInput.parse({ root: '' })).toThrow();
    expect(() => CodeGraphStatusInput.parse({ root: '' })).toThrow();
  });

  it('rejects a missing root', () => {
    expect(() => ScanCodebaseInput.parse({})).toThrow();
    expect(() => SyncCodeGraphInput.parse({})).toThrow();
    expect(() => CodeGraphStatusInput.parse({})).toThrow();
  });

  it('rejects a non-boolean followSymlinks', () => {
    expect(() => ScanCodebaseInput.parse({ root: '/x', followSymlinks: 'yes' })).toThrow();
  });
});

// ── Wiring tests (structural, against the source text) ────────────

const MCP_SERVER_SOURCE = await readFile(
  new URL('../../../src/mcp-server.ts', import.meta.url),
  'utf8',
);

describe('mcp-server wiring for the code-graph tools', () => {
  it('registers scan_codebase in listTools with the contract description and zod schema', () => {
    expect(MCP_SERVER_SOURCE).toContain("name: 'scan_codebase'");
    expect(MCP_SERVER_SOURCE).toContain(
      "Scan a local codebase directory (file discovery with .gitignore/.katraignore rules) and report what changed vs the last scan (added/modified/deleted/unchanged). Does NOT write to the knowledge graph. Use before sync_code_graph to preview changes, or to expand Katra\\'s view of a codebase it is working on.",
    );
    expect(MCP_SERVER_SOURCE).toContain(
      'inputSchema: zodToJsonSchema(ScanCodebaseInput) as Record<string, unknown>',
    );
  });

  it('registers sync_code_graph in listTools with the contract description and zod schema', () => {
    expect(MCP_SERVER_SOURCE).toContain("name: 'sync_code_graph'");
    expect(MCP_SERVER_SOURCE).toContain(
      'Scan a codebase, extract structure (classes, functions, methods, imports, calls) with tree-sitter, and merge it into the Katra knowledge graph. Deleted files are retracted. Returns counts of nodes/edges upserted and retracted.',
    );
    expect(MCP_SERVER_SOURCE).toContain(
      'inputSchema: zodToJsonSchema(SyncCodeGraphInput) as Record<string, unknown>',
    );
  });

  it('registers code_graph_status in listTools with the contract description and zod schema', () => {
    expect(MCP_SERVER_SOURCE).toContain("name: 'code_graph_status'");
    expect(MCP_SERVER_SOURCE).toContain(
      'Report the current state of a codebase in the Katra knowledge graph: node/edge counts and last sync time for the given root.',
    );
    expect(MCP_SERVER_SOURCE).toContain(
      'inputSchema: zodToJsonSchema(CodeGraphStatusInput) as Record<string, unknown>',
    );
  });

  it('defines the three async handler functions', () => {
    expect(MCP_SERVER_SOURCE).toMatch(/export async function handleScanCodebase\(args: unknown\): Promise<TextContent\[\]>/);
    expect(MCP_SERVER_SOURCE).toMatch(/export async function handleSyncCodeGraph\(args: unknown\): Promise<TextContent\[\]>/);
    expect(MCP_SERVER_SOURCE).toMatch(/export async function handleCodeGraphStatus\(args: unknown\): Promise<TextContent\[\]>/);
  });

  it('dispatches the three tool names in the CallTool switch', () => {
    expect(MCP_SERVER_SOURCE).toContain(
      "case 'scan_codebase': result = await handleScanCodebase(args); break;",
    );
    expect(MCP_SERVER_SOURCE).toContain(
      "case 'sync_code_graph': result = await handleSyncCodeGraph(args); break;",
    );
    expect(MCP_SERVER_SOURCE).toContain(
      "case 'code_graph_status': result = await handleCodeGraphStatus(args); break;",
    );
  });

  it('does not connect to MongoDB at module import time', () => {
    expect(is_database_connected()).toBe(false);
  });
});

// ── Direct handler tests: disconnected guard (runs everywhere) ────

describe('code-graph MCP handlers — disconnected guard', () => {
  it('scan_codebase returns a disconnected warning without a DB', async () => {
    const content = await handleScanCodebase({ root: '/tmp/irrelevant' });
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: '⚠️ MongoDB disconnected.' });
  });

  it('sync_code_graph returns a disconnected warning without a DB', async () => {
    const content = await handleSyncCodeGraph({ root: '/tmp/irrelevant' });
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: '⚠️ MongoDB disconnected.' });
  });

  it('code_graph_status returns a disconnected warning without a DB', async () => {
    const content = await handleCodeGraphStatus({ root: '/tmp/irrelevant' });
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: '⚠️ MongoDB disconnected.' });
  });
});

// ── Direct handler tests: full flow (MongoDB required) ────────────

describe.skipIf(!mongoAvailable)('code-graph MCP handlers — connected flow', () => {
  beforeAll(async () => {
    if (!process.env.MONGODB_URI) process.env.MONGODB_URI = MONGO_URI;
    const db = await connect_to_mongodb();
    expect(db).not.toBeNull();
  });

  afterAll(async () => {
    await close_connection();
  });

  /** One-off temp fixture root, removed in `finally`. */
  async function makeFixtureRoot(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
  }

  it('scan_codebase classifies a fresh fixture as added and performs no writes', async () => {
    const root = await makeFixtureRoot('katra-f4-scan-');
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'hello.ts'), 'export function hello() { return 1; }\n');
      await writeFile(join(root, 'util.py'), 'def add(a, b):\n    return a + b\n');
      await writeFile(join(root, 'README.md'), '# fixture\n');

      const content = await handleScanCodebase({ root });
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      const text = content[0].text;
      expect(text).toContain(`## Codebase Scan: ${root}`);
      expect(text).toContain('**Total files:** 3');
      expect(text).toContain('**Added:** 3');
      expect(text).toContain('**Modified:** 0');
      expect(text).toContain('**Deleted:** 0');
      expect(text).toContain('**Unchanged:** 0');
      expect(text).toContain('- README.md');
      expect(text).toContain('- src/hello.ts');
      expect(text).toContain('- util.py');

      // NO writes: no manifest document, no graph nodes, no graph edges.
      const db = get_database();
      const manifestId = createHash('sha256').update(resolve(root)).digest('hex');
      expect(await db.collection('code_scan_state').findOne({ _id: manifestId })).toBeNull();
      const resolvedRoot = resolve(root);
      expect(
        await db.collection('knowledge_nodes').countDocuments({
          id: { $regex: '^graphify:' },
          'properties.code_root': resolvedRoot,
        }),
      ).toBe(0);
      expect(
        await db.collection('knowledge_relationships').countDocuments({
          id: { $regex: '^graphify:edge:' },
          'properties.code_root': resolvedRoot,
        }),
      ).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('scan_codebase reports modified/deleted against a stored manifest and never saves', async () => {
    const root = await makeFixtureRoot('katra-f4-scan-diff-');
    try {
      await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(root, 'b.py'), 'x = 1\n');
      await writeFile(join(root, 'c.md'), '# c\n');

      const db = get_database();
      const store = new ManifestStore(db);
      // Seed the manifest with the current state (as a previous sync would).
      const seeded = await scanCodebase(root);
      const seededState: Record<string, { mtimeMs: number; size: number; hash: string }> = {};
      for (const f of seeded) {
        seededState[f.relPath] = { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash };
      }
      await store.saveManifest(root, seededState);

      // Second scan: nothing changed.
      const unchanged = await handleScanCodebase({ root });
      const unchangedText = unchanged[0].text;
      expect(unchangedText).toContain('**Unchanged:** 3');
      expect(unchangedText).toContain('**Added:** 0');

      // Modify b.py (mtime + hash) and delete c.md.
      await writeFile(join(root, 'b.py'), 'x = 2\n');
      await rm(join(root, 'c.md'));

      const content = await handleScanCodebase({ root });
      const text = content[0].text;
      expect(text).toContain('**Modified:** 1');
      expect(text).toContain('**Deleted:** 1');
      expect(text).toContain('- c.md');
      expect(text).toContain('**Unchanged:** 1');
      expect(text).toContain('**Added:** 0');

      // Scan must never save the manifest: the stored doc still has the
      // seeded updatedAt and still lists c.md.
      const manifestId = createHash('sha256').update(resolve(root)).digest('hex');
      const doc = await db.collection('code_scan_state').findOne({ _id: manifestId });
      expect(doc).not.toBeNull();
      expect(doc?.files['c.md']).toBeDefined();
    } finally {
      const manifestId = createHash('sha256').update(resolve(root)).digest('hex');
      await get_database().collection('code_scan_state').deleteOne({ _id: manifestId });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sync_code_graph extracts, upserts, and saves the manifest', async () => {
    const root = await makeFixtureRoot('katra-f4-sync-');
    try {
      await mkdir(join(root, 'src'));
      await writeFile(
        join(root, 'src', 'math.ts'),
        'export class Calculator {\n  add(a: number, b: number): number { return a + b; }\n}\n',
      );
      await writeFile(join(root, 'notes.md'), '# notes\n');

      const content = await handleSyncCodeGraph({ root });
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      const text = content[0].text;
      expect(text).toContain('## Code Graph Sync:');
      expect(text).toContain('**Scanned:** 2');
      expect(text).toContain('**Failed:** 0');
      expect(text).toContain('Manifest saved');

      const db = get_database();
      const resolvedRoot = resolve(root);
      const manifestId = createHash('sha256').update(resolvedRoot).digest('hex');
      const doc = await db.collection('code_scan_state').findOne({ _id: manifestId });
      expect(doc).not.toBeNull();
      expect(doc?.files['src/math.ts']).toBeDefined();

      const nodes = await db
        .collection('knowledge_nodes')
        .find({ id: { $regex: '^graphify:' }, 'properties.code_root': resolvedRoot })
        .toArray();
      expect(nodes.length).toBeGreaterThan(0);
      const kinds = new Set(nodes.map((n: any) => n.type));
      expect(kinds.has('file')).toBe(true);
      expect(kinds.has('class')).toBe(true);
      expect(kinds.has('method')).toBe(true);
      for (const n of nodes) {
        expect(n.source).toBe('katra-code');
        expect(n.user_id).toBe(DEFAULT_USER_ID);
      }

      const edges = await db
        .collection('knowledge_relationships')
        .find({ id: { $regex: '^graphify:edge:' }, 'properties.code_root': resolvedRoot })
        .toArray();
      expect(edges.length).toBeGreaterThan(0);

      const status = await handleCodeGraphStatus({ root });
      const statusText = status[0].text;
      expect(statusText).toContain(`**Nodes:** ${nodes.length}`);
      expect(statusText).toContain(`**Edges:** ${edges.length}`);
      expect(statusText).not.toContain('never synced');

      await db.collection('code_scan_state').deleteOne({ _id: manifestId });
      await db.collection('knowledge_nodes').deleteMany({ id: { $regex: '^graphify:' }, 'properties.code_root': resolvedRoot });
      await db.collection('knowledge_relationships').deleteMany({ id: { $regex: '^graphify:edge:' }, 'properties.code_root': resolvedRoot });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sync_code_graph wraps handler failures in an error text content', async () => {
    const content = await handleSyncCodeGraph({ root: '/tmp/katra-f4-definitely-missing' });
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('❌ Code graph sync failed');
  });

  it('code_graph_status reports never synced for an unknown root', async () => {
    const content = await handleCodeGraphStatus({ root: '/tmp/katra-f4-never-synced-root' });
    expect(content).toHaveLength(1);
    const text = content[0].text;
    expect(text).toContain('**Nodes:** 0');
    expect(text).toContain('**Edges:** 0');
    expect(text).toContain('never synced');
  });
});
