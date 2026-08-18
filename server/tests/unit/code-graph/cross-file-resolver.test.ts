/**
 * Unit tests: cross-file call resolution (F6)
 *
 * Pure unit suite, DB-free: every fixture file is part of the fresh
 * extraction map, so `resolveCrossFileCalls` is passed a mock Db whose
 * `collection()` throws — the resolver must never REQUIRE the DB when all
 * files are being replaced. Covers the evidence ladder (import evidence →
 * EXTRACTED 1.0, unique candidate → INFERRED, path-proximity strict winner →
 * INFERRED), the ambiguous skip (god-node guard), member-call conservatism
 * (no path proximity for `kind: 'method'`), constructor `new Widget()` →
 * class node, dangling-call dropping, and determinism.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import { extractFile } from '../../../src/services/code-graph/codebase-extractor.js';
import {
  buildClassIndex,
  buildLabelIndex,
  buildReturnTypeIndex,
  isTestPath,
  preferNonTest,
  resolveCrossFileCalls,
} from '../../../src/services/code-graph/cross-file-resolver.js';
import { rootKeyFor } from '../../../src/services/code-graph/code-graph-sync.js';
import type {
  CodeEdge,
  CodeNode,
  FileExtraction,
} from '../../../src/services/code-graph/types.js';

/** fixtures root: tests/fixtures → relPaths below are `code-graph/...`. */
const fixturesRoot = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Every cross-file fixture participates as a FRESH file (DB never needed). */
const CROSS_FILES = [
  'code-graph/cross-lib.ts',
  'code-graph/cross-caller-a.ts',
  'code-graph/cross-caller-b.ts',
  'code-graph/cross-ambig-1.ts',
  'code-graph/cross-ambig-2.ts',
  'code-graph/cross-ambig-caller.ts',
  'code-graph/cross-prox-a/callme.ts',
  'code-graph/cross-prox-b/callme.ts',
  'code-graph/cross-prox-a/use-near.ts',
  'code-graph/cross-class.ts',
  'code-graph/cross-new.ts',
  'code-graph/cross-memb-a/svc.ts',
  'code-graph/cross-memb-b/svc.ts',
  'code-graph/cross-memb-a/use-svc.ts',
];

/** Extract every cross fixture into a fresh extraction map. */
async function extractAll(): Promise<Map<string, FileExtraction>> {
  const extractions = new Map<string, FileExtraction>();
  for (const relPath of CROSS_FILES) {
    extractions.set(
      relPath,
      await extractFile(
        fixturesRoot,
        relPath,
        await readFile(join(fixturesRoot, relPath)),
      ),
    );
  }
  return extractions;
}

/**
 * Mock Db that throws on ANY collection access: with every file fresh the
 * resolver must produce its results without touching the database.
 */
const throwingDb = {
  collection() {
    throw new Error('resolveCrossFileCalls touched the DB although all files are fresh');
  },
} as unknown as Db;

/** Compact view of an edge, incl. confidence/weight/source location. */
function edgeView(edge: CodeEdge): string {
  return [
    edge.from,
    edge.relation,
    edge.to,
    edge.confidence,
    String(edge.weight),
    edge.sourceFile,
    edge.sourceLocation ?? '',
  ].join(' ');
}

function callsEdges(extractions: Map<string, FileExtraction>, relPath: string): string[] {
  const extraction = extractions.get(relPath);
  if (!extraction) throw new Error(`missing extraction for ${relPath}`);
  return extraction.edges
    .filter((edge) => edge.relation === 'calls')
    .map(edgeView);
}

describe('buildLabelIndex', () => {
  it('keys function labels `name()`, method labels `.name()` and bare class names only', async () => {
    const lib = await extractFile(
      fixturesRoot,
      'code-graph/cross-lib.ts',
      await readFile(join(fixturesRoot, 'code-graph/cross-lib.ts')),
    );
    const index = buildLabelIndex(lib.nodes);
    expect(index.get('helperA()')).toEqual([
      { id: 'code_graph_cross_lib_helpera', file: 'code-graph/cross-lib.ts' },
    ]);
    expect(index.get('helperB()')).toEqual([
      { id: 'code_graph_cross_lib_helperb', file: 'code-graph/cross-lib.ts' },
    ]);
    // File nodes are never resolvable symbols.
    expect(index.get('cross-lib.ts')).toBeUndefined();
  });

  it('indexes class names (constructor targets) and `.name()` method labels', async () => {
    const cls = await extractFile(
      fixturesRoot,
      'code-graph/cross-class.ts',
      await readFile(join(fixturesRoot, 'code-graph/cross-class.ts')),
    );
    const index = buildLabelIndex(cls.nodes);
    expect(index.get('Widget')).toEqual([
      { id: 'code_graph_cross_class_widget', file: 'code-graph/cross-class.ts' },
    ]);
    expect(index.get('.ping()')).toEqual([
      { id: 'code_graph_cross_class_widget_ping', file: 'code-graph/cross-class.ts' },
    ]);
  });
});

describe('resolveCrossFileCalls', () => {
  it('resolves the evidence ladder without touching the DB when all files are fresh', async () => {
    const extractions = await extractAll();
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 4, skippedAmbiguous: 2, danglingDropped: 0 });

    // Import evidence → EXTRACTED, weight 1, on the caller's file.
    expect(callsEdges(extractions, 'code-graph/cross-caller-a.ts')).toEqual([
      'code_graph_cross_caller_a_runa calls code_graph_cross_lib_helpera EXTRACTED 1 code-graph/cross-caller-a.ts L4',
    ]);

    // No import but a globally unique candidate → INFERRED, weight 1.
    expect(callsEdges(extractions, 'code-graph/cross-caller-b.ts')).toEqual([
      'code_graph_cross_caller_b_runb calls code_graph_cross_lib_helpera INFERRED 1 code-graph/cross-caller-b.ts L2',
    ]);

    // Two same-dir candidates → ambiguous skip (god-node guard).
    expect(callsEdges(extractions, 'code-graph/cross-ambig-caller.ts')).toEqual([]);

    // Path proximity: strict unique same-dir winner → INFERRED.
    expect(callsEdges(extractions, 'code-graph/cross-prox-a/use-near.ts')).toEqual([
      'code_graph_cross_prox_a_use_near_runp calls code_graph_cross_prox_a_callme_near INFERRED 1 code-graph/cross-prox-a/use-near.ts L3',
    ]);

    // `new Widget()` → constructor lookup → the cross-class.ts class node.
    expect(callsEdges(extractions, 'code-graph/cross-new.ts')).toEqual([
      'code_graph_cross_new_make calls code_graph_cross_class_widget EXTRACTED 1 code-graph/cross-new.ts L4',
    ]);

    // Member call with two candidates and no import evidence: conservatively
    // skipped even though path proximity has a strict winner.
    expect(callsEdges(extractions, 'code-graph/cross-memb-a/use-svc.ts')).toEqual([]);
  });

  it('marks INFERRED edges with confidence INFERRED (weight stays 1)', async () => {
    const extractions = await extractAll();
    await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    const inferred = extractions
      .get('code-graph/cross-caller-b.ts')!
      .edges.filter((e) => e.relation === 'calls');
    expect(inferred).toHaveLength(1);
    expect(inferred[0]).toMatchObject({
      confidence: 'INFERRED',
      weight: 1,
      sourceFile: 'code-graph/cross-caller-b.ts',
      sourceLocation: 'L2',
    });
  });

  it('counts calls to symbols that exist nowhere as danglingDropped (never invents nodes)', async () => {
    const extractions = await extractAll();
    const ghost: FileExtraction = {
      nodes: [
        {
          id: 'code_graph_ghost',
          label: 'ghost.ts',
          kind: 'file',
          sourceFile: 'code-graph/ghost.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'code_graph_ghost_main',
          label: 'main()',
          kind: 'function',
          sourceFile: 'code-graph/ghost.ts',
          sourceLocation: 'L1',
        },
      ],
      edges: [],
      errors: [],
      rawCalls: [
        {
          caller: 'code_graph_ghost_main',
          callee: 'ghost',
          kind: 'function',
          sourceLocation: 'L1',
        },
      ],
    };
    extractions.set('code-graph/ghost.ts', ghost);

    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result.danglingDropped).toBe(1);
    expect(result.resolved).toBe(4);
    // No node was invented for the ghost call.
    const nodes = [...extractions.values()].flatMap((e) => e.nodes);
    expect(nodes.some((n) => n.label === 'ghost()')).toBe(false);
    expect(callsEdges(extractions, 'code-graph/ghost.ts')).toEqual([]);
  });

  it('is deterministic — two independent runs produce identical edge order', async () => {
    const first = await extractAll();
    const second = await extractAll();
    const resultA = await resolveCrossFileCalls(throwingDb, fixturesRoot, first);
    const resultB = await resolveCrossFileCalls(throwingDb, fixturesRoot, second);
    expect(resultA).toEqual(resultB);
    for (const relPath of CROSS_FILES) {
      expect(callsEdges(first, relPath)).toEqual(callsEdges(second, relPath));
    }
  });
});

/* ── F7: typed member-call resolution ───────────────────────────────────── */

/** Every memb-* fixture participates as a FRESH file (DB never needed). */
const MEMB_FILES = [
  'code-graph/memb-lib.ts',
  'code-graph/memb-use-a.ts',
  'code-graph/memb-use-b.ts',
  'code-graph/memb-use-c.ts',
  'code-graph/memb-use-d.ts',
  'code-graph/memb-use-e.ts',
  'code-graph/memb-this.ts',
  'code-graph/memb-ambig-class-a.ts',
  'code-graph/memb-ambig-class-b.ts',
  'code-graph/memb-ambig-use.ts',
  'code-graph/memb-ambig-bound.ts',
];

/** Extract every memb fixture into a fresh extraction map. */
async function extractMembAll(): Promise<Map<string, FileExtraction>> {
  const extractions = new Map<string, FileExtraction>();
  for (const relPath of MEMB_FILES) {
    extractions.set(
      relPath,
      await extractFile(
        fixturesRoot,
        relPath,
        await readFile(join(fixturesRoot, relPath)),
      ),
    );
  }
  return extractions;
}

describe('buildClassIndex', () => {
  it('keys class nodes by their bare class label', async () => {
    const lib = await extractFile(
      fixturesRoot,
      'code-graph/memb-lib.ts',
      await readFile(join(fixturesRoot, 'code-graph/memb-lib.ts')),
    );
    const index = buildClassIndex(lib.nodes);
    expect(index.get('Store')).toEqual([
      { id: 'code_graph_memb_lib_store', file: 'code-graph/memb-lib.ts' },
    ]);
    // Method and file nodes are not class-name candidates.
    expect(index.get('.count()')).toBeUndefined();
    expect(index.get('memb-lib.ts')).toBeUndefined();
  });

  it('lists every same-named class (ambiguity is resolved later)', async () => {
    const a = await extractFile(
      fixturesRoot,
      'code-graph/memb-ambig-class-a.ts',
      await readFile(join(fixturesRoot, 'code-graph/memb-ambig-class-a.ts')),
    );
    const b = await extractFile(
      fixturesRoot,
      'code-graph/memb-ambig-class-b.ts',
      await readFile(join(fixturesRoot, 'code-graph/memb-ambig-class-b.ts')),
    );
    const index = buildClassIndex([...a.nodes, ...b.nodes]);
    expect(index.get('Dup')).toEqual([
      { id: 'code_graph_memb_ambig_class_a_dup', file: 'code-graph/memb-ambig-class-a.ts' },
      { id: 'code_graph_memb_ambig_class_b_dup', file: 'code-graph/memb-ambig-class-b.ts' },
    ]);
  });
});

describe('resolveCrossFileCalls — typed member calls (F7)', () => {
  it('resolves every typed receiver to the existing method node (never touching the DB)', async () => {
    const extractions = await extractMembAll();
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 9, skippedAmbiguous: 2, danglingDropped: 0 });

    // annotation receiver → EXTRACTED calls to memb_lib_store_count; the
    // `new Store()` constructor also resolves via import evidence (F6).
    expect(callsEdges(extractions, 'code-graph/memb-use-a.ts')).toEqual([
      'code_graph_memb_use_a_annot calls code_graph_memb_lib_store_count EXTRACTED 1 code-graph/memb-use-a.ts L3',
      'code_graph_memb_use_a_annot calls code_graph_memb_lib_store EXTRACTED 1 code-graph/memb-use-a.ts L3',
    ]);

    // `new Store()` receiver → EXTRACTED calls to memb_lib_store_push.
    expect(callsEdges(extractions, 'code-graph/memb-use-b.ts')).toEqual([
      'code_graph_memb_use_b_cons calls code_graph_memb_lib_store_push EXTRACTED 1 code-graph/memb-use-b.ts L3',
      'code_graph_memb_use_b_cons calls code_graph_memb_lib_store EXTRACTED 1 code-graph/memb-use-b.ts L3',
    ]);

    // parameter receiver → EXTRACTED.
    expect(callsEdges(extractions, 'code-graph/memb-use-c.ts')).toEqual([
      'code_graph_memb_use_c_param calls code_graph_memb_lib_store_count EXTRACTED 1 code-graph/memb-use-c.ts L3',
    ]);

    // same-file return flow → INFERRED; the `makeStore()` call itself
    // resolves in-file (EXTRACTED, extraction-time edge without a location).
    expect(callsEdges(extractions, 'code-graph/memb-use-d.ts')).toEqual([
      'code_graph_memb_use_d_flow calls code_graph_memb_use_d_makestore EXTRACTED 1 code-graph/memb-use-d.ts ',
      'code_graph_memb_use_d_makestore calls code_graph_memb_lib_store EXTRACTED 1 code-graph/memb-use-d.ts L3',
      'code_graph_memb_use_d_flow calls code_graph_memb_lib_store_count INFERRED 1 code-graph/memb-use-d.ts L4',
    ]);

    // bare `this` receiver → enclosing class (EXTRACTED).
    expect(callsEdges(extractions, 'code-graph/memb-this.ts')).toEqual([
      'code_graph_memb_this_derived_go calls code_graph_memb_this_derived_step EXTRACTED 1 code-graph/memb-this.ts L10',
    ]);

    // untyped receiver: F6 ladder over `.whatever()` finds two candidates →
    // skipped (god-node guard).
    expect(callsEdges(extractions, 'code-graph/memb-use-e.ts')).toEqual([]);

    // ambiguous type name with no import binding → skipped.
    expect(callsEdges(extractions, 'code-graph/memb-ambig-use.ts')).toEqual([]);

    // ambiguous type name IMPORT-BOUND to memb-ambig-class-a.ts → resolves
    // to the imported file's class method (F7 import-evidence branch).
    expect(callsEdges(extractions, 'code-graph/memb-ambig-bound.ts')).toEqual([
      'code_graph_memb_ambig_bound_boundcall calls code_graph_memb_ambig_class_a_dup_ping EXTRACTED 1 code-graph/memb-ambig-bound.ts L5',
    ]);
  });

  it('resolves a globally-ambiguous type name only when the caller imports the class (import-bound)', async () => {
    const extractions = await extractMembAll();
    await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // `Dup` exists in TWO files. Without an import binding the typed call is
    // skipped (god-node guard); with `import { Dup } from
    // './memb-ambig-class-a.js'` it resolves to exactly the imported file's
    // class method — never to the other same-named class.
    expect(callsEdges(extractions, 'code-graph/memb-ambig-use.ts')).toEqual([]);
    expect(callsEdges(extractions, 'code-graph/memb-ambig-bound.ts')).toEqual([
      'code_graph_memb_ambig_bound_boundcall calls code_graph_memb_ambig_class_a_dup_ping EXTRACTED 1 code-graph/memb-ambig-bound.ts L5',
    ]);
    expect(
      callsEdges(extractions, 'code-graph/memb-ambig-bound.ts')[0].includes(
        'code_graph_memb_ambig_class_b',
      ),
    ).toBe(false);
  });

  it('never invents a method node (typed class exists, method does not)', async () => {
    const extractions = await extractMembAll();
    const ghost: FileExtraction = {
      nodes: [
        {
          id: 'code_graph_memb_ghost',
          label: 'memb-ghost.ts',
          kind: 'file',
          sourceFile: 'code-graph/memb-ghost.ts',
          sourceLocation: 'L1',
        },
      ],
      edges: [],
      errors: [],
      rawCalls: [
        {
          caller: 'code_graph_memb_ghost',
          callee: 'noSuchMethod',
          kind: 'method',
          sourceLocation: 'L1',
          receiver: { name: 's', typeName: 'Store', typeSource: 'new' },
        },
      ],
    };
    extractions.set('code-graph/memb-ghost.ts', ghost);

    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // The two fixture skips (whatever/ping) plus the ghost typed call.
    expect(result.skippedAmbiguous).toBe(3);
    expect(callsEdges(extractions, 'code-graph/memb-ghost.ts')).toEqual([]);
    // No node was invented anywhere.
    const nodes = [...extractions.values()].flatMap((e) => e.nodes);
    expect(nodes.some((n) => n.id === 'code_graph_memb_lib_store_nosuchmethod')).toBe(false);
  });

  it('is deterministic — two independent runs produce identical typed edges', async () => {
    const first = await extractMembAll();
    const second = await extractMembAll();
    const resultA = await resolveCrossFileCalls(throwingDb, fixturesRoot, first);
    const resultB = await resolveCrossFileCalls(throwingDb, fixturesRoot, second);
    expect(resultA).toEqual(resultB);
    for (const relPath of MEMB_FILES) {
      expect(callsEdges(first, relPath)).toEqual(callsEdges(second, relPath));
    }
  });
});

/* ── F8: cross-file return-type propagation ────────────────────────────── */

/** Every ret-* fixture participates as a FRESH file (DB never needed). */
const RET_FILES = [
  'code-graph/ret-lib.ts',
  'code-graph/ret-use-a.ts',
  'code-graph/ret-use-b.ts',
  'code-graph/ret-ambig-1.ts',
  'code-graph/ret-ambig-2.ts',
  'code-graph/ret-ambig-use.ts',
  'code-graph/ret-importbound.ts',
  'code-graph/ret-noretype.ts',
];

/** Extract every ret fixture into a fresh extraction map. */
async function extractRetAll(): Promise<Map<string, FileExtraction>> {
  const extractions = new Map<string, FileExtraction>();
  for (const relPath of RET_FILES) {
    extractions.set(
      relPath,
      await extractFile(
        fixturesRoot,
        relPath,
        await readFile(join(fixturesRoot, relPath)),
      ),
    );
  }
  return extractions;
}

/** Fake Db returning canned `knowledge_nodes` docs from find().toArray(). */
function fakeDb(docs: unknown[]): Db {
  return {
    collection() {
      return {
        find: () => ({ toArray: async () => docs }),
      };
    },
  } as unknown as Db;
}

describe('buildReturnTypeIndex', () => {
  it('keys annotated functions by label with their declared return type', async () => {
    const lib = await extractFile(
      fixturesRoot,
      'code-graph/ret-lib.ts',
      await readFile(join(fixturesRoot, 'code-graph/ret-lib.ts')),
    );
    const index = buildReturnTypeIndex(lib.nodes);
    expect(index.get('makeEngine()')).toEqual([
      { typeName: 'Engine', file: 'code-graph/ret-lib.ts' },
    ]);
    // Methods, classes, and unannotated functions never enter the index.
    expect(index.get('.start()')).toBeUndefined();
    expect(index.get('Engine')).toBeUndefined();
  });

  it('includes stored return types reconstructed from properties.return_type', async () => {
    const stored: CodeNode[] = [
      {
        id: 'code_graph_ret_lib_makeengine',
        label: 'makeEngine()',
        kind: 'function',
        sourceFile: 'code-graph/ret-lib.ts',
        returnType: 'Engine',
      },
    ];
    const index = buildReturnTypeIndex(stored);
    expect(index.get('makeEngine()')).toEqual([
      { typeName: 'Engine', file: 'code-graph/ret-lib.ts' },
    ]);
  });
});

describe('resolveCrossFileCalls — cross-file return-type propagation (F8)', () => {
  it('resolves initializer receivers to the return type\'s method (INFERRED), import-bound and unique', async () => {
    const extractions = await extractRetAll();
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 11, skippedAmbiguous: 2, danglingDropped: 0 });

    // ret-use-a: makeEngine() import-bound → Engine.start() INFERRED.
    expect(callsEdges(extractions, 'code-graph/ret-use-a.ts')).toEqual([
      'code_graph_ret_use_a_boot calls code_graph_ret_lib_makeengine EXTRACTED 1 code-graph/ret-use-a.ts L7',
      'code_graph_ret_use_a_boot calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/ret-use-a.ts L8',
    ]);

    // ret-use-b (F7 control): annotation receiver → EXTRACTED, unchanged
    // (the member rawCall precedes the constructor rawCall in emission order).
    expect(callsEdges(extractions, 'code-graph/ret-use-b.ts')).toEqual([
      'code_graph_ret_use_b_typed calls code_graph_ret_lib_engine_stop EXTRACTED 1 code-graph/ret-use-b.ts L7',
      'code_graph_ret_use_b_typed calls code_graph_ret_lib_engine EXTRACTED 1 code-graph/ret-use-b.ts L6',
    ]);

    // Ambiguous initializer without import evidence → the F8 lookup fails →
    // falls through to the F6 ladder: `.goA()` is globally unique → INFERRED.
    expect(callsEdges(extractions, 'code-graph/ret-ambig-use.ts')).toEqual([
      'code_graph_ret_ambig_use_useambiguous calls code_graph_ret_ambig_1_enginea_goa INFERRED 1 code-graph/ret-ambig-use.ts L6',
    ]);

    // Import-bound initializer disambiguation: EngineA's method, not EngineB's.
    expect(callsEdges(extractions, 'code-graph/ret-importbound.ts')).toEqual([
      'code_graph_ret_importbound_bound calls code_graph_ret_ambig_1_makeit EXTRACTED 1 code-graph/ret-importbound.ts L7',
      'code_graph_ret_importbound_bound calls code_graph_ret_ambig_1_enginea_goa INFERRED 1 code-graph/ret-importbound.ts L8',
    ]);

    // No-annotation initializer → the F8 lookup fails → falls through to the
    // F6 ladder: `.stop()` is globally unique → INFERRED; `.halt()` is
    // ambiguous (HalterA/HalterB) → still skipped (god-node guard).
    expect(callsEdges(extractions, 'code-graph/ret-noretype.ts')).toEqual([
      'code_graph_ret_noretype_usesnotype calls code_graph_ret_noretype_notypefn EXTRACTED 1 code-graph/ret-noretype.ts ',
      'code_graph_ret_noretype_usesambig calls code_graph_ret_noretype_notypefn EXTRACTED 1 code-graph/ret-noretype.ts ',
      'code_graph_ret_noretype_usesnotype calls code_graph_ret_lib_engine_stop INFERRED 1 code-graph/ret-noretype.ts L20',
    ]);
  });

  it('a successful F8 resolution emits exactly ONE INFERRED edge (the ladder never double-emits)', async () => {
    const extractions = await extractRetAll();
    await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // ret-use-a's `e.start()` resolves through F8 (makeEngine → Engine); the
    // `continue` after success must prevent the F6 ladder from appending a
    // second edge to the same method node.
    const startEdges = callsEdges(extractions, 'code-graph/ret-use-a.ts').filter(
      (edge) => edge.includes('code_graph_ret_lib_engine_start'),
    );
    expect(startEdges).toEqual([
      'code_graph_ret_use_a_boot calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/ret-use-a.ts L8',
    ]);
  });

  it('falls through when the initializer return type matches no class — the label is dangling-dropped (never invents nodes)', async () => {
    const extractions = await extractRetAll();
    const missing: FileExtraction = {
      nodes: [
        {
          id: 'code_graph_ret_missing',
          label: 'ret-missing.ts',
          kind: 'file',
          sourceFile: 'code-graph/ret-missing.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'code_graph_ret_missing_makething',
          label: 'makeThing()',
          kind: 'function',
          sourceFile: 'code-graph/ret-missing.ts',
          sourceLocation: 'L2',
          returnType: 'NoSuchClass',
        },
        {
          id: 'code_graph_ret_missing_use',
          label: 'use()',
          kind: 'function',
          sourceFile: 'code-graph/ret-missing.ts',
          sourceLocation: 'L3',
        },
      ],
      edges: [],
      errors: [],
      rawCalls: [
        {
          caller: 'code_graph_ret_missing_use',
          callee: 'ping',
          kind: 'method',
          sourceLocation: 'L3',
          receiver: {
            name: 't',
            typeSource: 'return_flow',
            initializerCall: 'makeThing',
          },
        },
      ],
    };
    extractions.set('code-graph/ret-missing.ts', missing);

    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // Unknown class → F8 fails → falls through → `.ping()` exists nowhere →
    // danglingDropped (not skippedAmbiguous): 2 fixture skips + 1 drop.
    expect(result).toEqual({ resolved: 11, skippedAmbiguous: 2, danglingDropped: 1 });
    expect(callsEdges(extractions, 'code-graph/ret-missing.ts')).toEqual([]);
    // No class or method node was invented anywhere.
    const nodes = [...extractions.values()].flatMap((e) => e.nodes);
    expect(nodes.some((n) => n.id.includes('nosuchclass'))).toBe(false);
  });

  it('reconstructs unchanged files\' return types from stored properties.return_type', async () => {
    // Only ret-use-a.ts is FRESH; ret-lib.ts is unchanged and stands in via
    // the DB — its makeEngine()'s return type must come from
    // properties.return_type (root-scoped stored ids, katra-code shape).
    const rootKey = rootKeyFor(resolve(fixturesRoot));
    const storedDoc = (
      bareId: string,
      name: string,
      type: string,
      sourceFile: string,
      extra?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id: `graphify:${rootKey}:${bareId}`,
      name,
      type,
      properties: {
        name,
        source_path: sourceFile,
        source_file: sourceFile,
        code_root: resolve(fixturesRoot),
        ...extra,
      },
      source: 'katra-code',
    });

    const extractions = new Map<string, FileExtraction>();
    extractions.set(
      'code-graph/ret-use-a.ts',
      await extractFile(
        fixturesRoot,
        'code-graph/ret-use-a.ts',
        await readFile(join(fixturesRoot, 'code-graph/ret-use-a.ts')),
      ),
    );

    const db = fakeDb([
      storedDoc('code_graph_ret_lib', 'ret-lib.ts', 'file', 'code-graph/ret-lib.ts'),
      storedDoc('code_graph_ret_lib_engine', 'Engine', 'class', 'code-graph/ret-lib.ts'),
      storedDoc(
        'code_graph_ret_lib_engine_start',
        '.start()',
        'method',
        'code-graph/ret-lib.ts',
      ),
      storedDoc(
        'code_graph_ret_lib_engine_stop',
        '.stop()',
        'method',
        'code-graph/ret-lib.ts',
      ),
      storedDoc(
        'code_graph_ret_lib_makeengine',
        'makeEngine()',
        'function',
        'code-graph/ret-lib.ts',
        { return_type: 'Engine' },
      ),
    ]);

    const result = await resolveCrossFileCalls(db, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 2, skippedAmbiguous: 0, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/ret-use-a.ts')).toEqual([
      'code_graph_ret_use_a_boot calls code_graph_ret_lib_makeengine EXTRACTED 1 code-graph/ret-use-a.ts L7',
      'code_graph_ret_use_a_boot calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/ret-use-a.ts L8',
    ]);
  });

  it('is deterministic — two independent runs produce identical F8 edges', async () => {
    const first = await extractRetAll();
    const second = await extractRetAll();
    const resultA = await resolveCrossFileCalls(throwingDb, fixturesRoot, first);
    const resultB = await resolveCrossFileCalls(throwingDb, fixturesRoot, second);
    expect(resultA).toEqual(resultB);
    for (const relPath of RET_FILES) {
      expect(callsEdges(first, relPath)).toEqual(callsEdges(second, relPath));
    }
  });
});

/* ── Graphify test-path preference (F8 gate regression fix) ───────────── */

describe('isTestPath (Graphify _is_test_path port)', () => {
  it('classifies test dir segments, test filenames, and convention edge cases', () => {
    // Whole-path-segment test directories.
    expect(isTestPath('server/tests/unit/a.ts')).toBe(true);
    expect(isTestPath('src/test/helper.ts')).toBe(true);
    expect(isTestPath('specs/run.ts')).toBe(true);
    expect(isTestPath('__tests__/a.ts')).toBe(true);
    // Test filename conventions.
    expect(isTestPath('x.test.ts')).toBe(true);
    expect(isTestPath('x.spec.ts')).toBe(true);
    expect(isTestPath('test_utils.ts')).toBe(true);
    expect(isTestPath('utils_test.ts')).toBe(true);
    expect(isTestPath('utils_spec.ts')).toBe(true);
    expect(isTestPath('run.Tests.ps1')).toBe(true);
    expect(isTestPath('FooTest.java')).toBe(true);
    expect(isTestPath('FooTests.cs')).toBe(true);
    // NON-test: plain files, substring lookalikes, unmatched conventions.
    expect(isTestPath('src/app.ts')).toBe(false);
    expect(isTestPath('test-utils.ts')).toBe(false);
    expect(isTestPath('src/contest.ts')).toBe(false);
    expect(isTestPath('src/latest/x.ts')).toBe(false);
    expect(isTestPath('contest.cs')).toBe(false);
    expect(isTestPath('')).toBe(false);
    // Windows separators normalize like Graphify's `\\` → `/` swap.
    expect(isTestPath('src\\tests\\a.ts')).toBe(true);
  });
});

describe('preferNonTest (Graphify disambiguate stage 1)', () => {
  const testCandidate = {
    id: 'code_graph_start_test_shutdown_start',
    file: 'code-graph/start.test.ts',
  };
  const realCandidate = {
    id: 'code_graph_ret_lib_engine_start',
    file: 'code-graph/ret-lib.ts',
  };

  it('a non-test caller drops test-file candidates (order preserved)', () => {
    expect(preferNonTest([testCandidate, realCandidate], 'code-graph/svc.ts')).toEqual([
      realCandidate,
    ]);
  });

  it('a test caller keeps the full candidate set (test-local resolution allowed)', () => {
    expect(
      preferNonTest([testCandidate, realCandidate], 'code-graph/use.test.ts'),
    ).toEqual([testCandidate, realCandidate]);
  });

  it('leaves single/empty candidate lists untouched (Graphify short-circuits before the test filter)', () => {
    expect(preferNonTest([testCandidate], 'code-graph/svc.ts')).toEqual([testCandidate]);
    expect(preferNonTest([], 'code-graph/svc.ts')).toEqual([]);
  });
});

describe('resolveCrossFileCalls — Graphify test-path preference (F8 gate regression)', () => {
  const START_TEST_FIXTURE = 'code-graph/start.test.ts';

  async function extractStartTestFixture(): Promise<FileExtraction> {
    return extractFile(
      fixturesRoot,
      START_TEST_FIXTURE,
      await readFile(join(fixturesRoot, START_TEST_FIXTURE)),
    );
  }

  /** A receiver-less `.start()` caller (the F6 ladder surface). */
  function startCaller(
    relPath: string,
    fnId: string,
    fileId: string,
    importsTo: string[] = [],
  ): FileExtraction {
    return {
      nodes: [
        {
          id: fileId,
          label: relPath.split('/').pop() ?? relPath,
          kind: 'file',
          sourceFile: relPath,
          sourceLocation: 'L1',
        },
        {
          id: fnId,
          label: 'run()',
          kind: 'function',
          sourceFile: relPath,
          sourceLocation: 'L1',
        },
      ],
      edges: importsTo.map((to) => ({
        from: fileId,
        to,
        relation: 'imports_from',
        confidence: 'EXTRACTED',
        weight: 1,
        sourceFile: relPath,
      })),
      errors: [],
      rawCalls: [{ caller: fnId, callee: 'start', kind: 'method', sourceLocation: 'L2' }],
    };
  }

  /** Test-file `Engine` mock: class + `.start()` (+ optional makeEngine). */
  function engineMockTest(withFactory: boolean): FileExtraction {
    const nodes: CodeNode[] = [
      {
        id: 'code_graph_engine_mock_test',
        label: 'engine-mock.test.ts',
        kind: 'file',
        sourceFile: 'code-graph/engine-mock.test.ts',
        sourceLocation: 'L1',
      },
      {
        id: 'code_graph_engine_mock_test_engine',
        label: 'Engine',
        kind: 'class',
        sourceFile: 'code-graph/engine-mock.test.ts',
        sourceLocation: 'L2',
      },
      {
        id: 'code_graph_engine_mock_test_engine_start',
        label: '.start()',
        kind: 'method',
        sourceFile: 'code-graph/engine-mock.test.ts',
        sourceLocation: 'L3',
      },
    ];
    if (withFactory) {
      nodes.push({
        id: 'code_graph_engine_mock_test_makeengine',
        label: 'makeEngine()',
        kind: 'function',
        sourceFile: 'code-graph/engine-mock.test.ts',
        sourceLocation: 'L5',
        returnType: 'Engine',
      });
    }
    return { nodes, edges: [], errors: [], rawCalls: [] };
  }

  it('a non-test caller resolves `.start()` to the NON-test candidate when a test mock shares the label', async () => {
    const extractions = await extractRetAll();
    extractions.set(START_TEST_FIXTURE, await extractStartTestFixture());
    extractions.set(
      'code-graph/real-svc.ts',
      startCaller('code-graph/real-svc.ts', 'code_graph_real_svc_run', 'code_graph_real_svc'),
    );
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // F8 baseline (11 resolved / 2 ambiguous) + the one preference-narrowed
    // resolution: the skipped-ambiguous count DECREASES for this shape.
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 2, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/real-svc.ts')).toEqual([
      'code_graph_real_svc_run calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/real-svc.ts L2',
    ]);
  });

  it('preserves the old uniqueness behavior when the test fixture is absent', async () => {
    const extractions = await extractRetAll();
    extractions.set(
      'code-graph/real-svc.ts',
      startCaller('code-graph/real-svc.ts', 'code_graph_real_svc_run', 'code_graph_real_svc'),
    );
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 2, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/real-svc.ts')).toEqual([
      'code_graph_real_svc_run calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/real-svc.ts L2',
    ]);
  });

  it('test callers may resolve to test files; without import evidence they still skip', async () => {
    const extractions = await extractRetAll();
    extractions.set(START_TEST_FIXTURE, await extractStartTestFixture());
    // Test caller IMPORT-BOUND to start.test.ts → resolves to the test file's
    // method (import evidence wins regardless of test/non-test).
    extractions.set(
      'code-graph/use-shutdown.test.ts',
      startCaller(
        'code-graph/use-shutdown.test.ts',
        'code_graph_use_shutdown_test_toggle',
        'code_graph_use_shutdown_test',
        ['code_graph_start_test'],
      ),
    );
    // Test caller WITHOUT import evidence: no filtering for test callers →
    // two candidates remain → ambiguous skip (god-node guard holds).
    extractions.set(
      'code-graph/plain.test.ts',
      startCaller('code-graph/plain.test.ts', 'code_graph_plain_test_check', 'code_graph_plain_test'),
    );
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 3, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/use-shutdown.test.ts')).toEqual([
      'code_graph_use_shutdown_test_toggle calls code_graph_start_test_shutdown_start EXTRACTED 1 code-graph/use-shutdown.test.ts L2',
    ]);
    expect(callsEdges(extractions, 'code-graph/plain.test.ts')).toEqual([]);
  });

  it('F7 typed class-name ambiguity: a non-test caller prefers the NON-test class candidate', async () => {
    const extractions = await extractRetAll();
    extractions.set('code-graph/engine-mock.test.ts', engineMockTest(false));
    extractions.set('code-graph/typed-svc.ts', {
      nodes: [
        {
          id: 'code_graph_typed_svc',
          label: 'typed-svc.ts',
          kind: 'file',
          sourceFile: 'code-graph/typed-svc.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'code_graph_typed_svc_run',
          label: 'run()',
          kind: 'function',
          sourceFile: 'code-graph/typed-svc.ts',
          sourceLocation: 'L1',
        },
      ],
      edges: [],
      errors: [],
      rawCalls: [
        {
          caller: 'code_graph_typed_svc_run',
          callee: 'start',
          kind: 'method',
          sourceLocation: 'L2',
          receiver: { name: 'e', typeName: 'Engine', typeSource: 'annotation' },
        },
      ],
    });
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 2, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/typed-svc.ts')).toEqual([
      'code_graph_typed_svc_run calls code_graph_ret_lib_engine_start EXTRACTED 1 code-graph/typed-svc.ts L2',
    ]);
  });

  it('F8 return-type initializer ambiguity: a non-test caller prefers the NON-test return-type candidate', async () => {
    const extractions = await extractRetAll();
    extractions.set('code-graph/engine-mock.test.ts', engineMockTest(true));
    extractions.set('code-graph/svc-factory.ts', {
      nodes: [
        {
          id: 'code_graph_svc_factory',
          label: 'svc-factory.ts',
          kind: 'file',
          sourceFile: 'code-graph/svc-factory.ts',
          sourceLocation: 'L1',
        },
        {
          id: 'code_graph_svc_factory_run',
          label: 'run()',
          kind: 'function',
          sourceFile: 'code-graph/svc-factory.ts',
          sourceLocation: 'L1',
        },
      ],
      edges: [],
      errors: [],
      rawCalls: [
        {
          caller: 'code_graph_svc_factory_run',
          callee: 'start',
          kind: 'method',
          sourceLocation: 'L2',
          receiver: { name: 's', typeSource: 'return_flow', initializerCall: 'makeEngine' },
        },
      ],
    });
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 2, danglingDropped: 0 });
    expect(callsEdges(extractions, 'code-graph/svc-factory.ts')).toEqual([
      'code_graph_svc_factory_run calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/svc-factory.ts L2',
    ]);
  });

  it('F8 lookup failure falls through to the F6 ladder with test-path preference (live gate shape)', async () => {
    // Live shape: `const e = makeX(); e.start()` in a NON-test file where
    // makeX() has NO returnType anywhere → the F8 initializer lookup fails →
    // falls through. `.start()` has candidates in a test file (start.test.ts)
    // AND a non-test file (ret-lib.ts) → the F6 ladder's test-path preference
    // narrows to the NON-test method (INFERRED).
    const extractions = await extractRetAll();
    extractions.set(START_TEST_FIXTURE, await extractStartTestFixture());
    extractions.set(
      'code-graph/ret-fallback.ts',
      await extractFile(
        fixturesRoot,
        'code-graph/ret-fallback.ts',
        await readFile(join(fixturesRoot, 'code-graph/ret-fallback.ts')),
      ),
    );
    const result = await resolveCrossFileCalls(throwingDb, fixturesRoot, extractions);
    // F8 baseline (11/2) + the one fall-through resolution.
    expect(result).toEqual({ resolved: 12, skippedAmbiguous: 2, danglingDropped: 0 });
    // The in-file makeX() call keeps its extraction-time edge; `e.start()`
    // resolves to the NON-test Engine.start() (never the test mock).
    expect(callsEdges(extractions, 'code-graph/ret-fallback.ts')).toEqual([
      'code_graph_ret_fallback_usefallback calls code_graph_ret_fallback_makex EXTRACTED 1 code-graph/ret-fallback.ts ',
      'code_graph_ret_fallback_usefallback calls code_graph_ret_lib_engine_start INFERRED 1 code-graph/ret-fallback.ts L12',
    ]);
    expect(
      callsEdges(extractions, 'code-graph/ret-fallback.ts').some((edge) =>
        edge.includes('code_graph_start_test'),
      ),
    ).toBe(false);
  });
});
