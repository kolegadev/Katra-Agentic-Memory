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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from 'mongodb';
import { extractFile } from '../../../src/services/code-graph/codebase-extractor.js';
import {
  buildLabelIndex,
  resolveCrossFileCalls,
} from '../../../src/services/code-graph/cross-file-resolver.js';
import type { CodeEdge, FileExtraction } from '../../../src/services/code-graph/types.js';

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
