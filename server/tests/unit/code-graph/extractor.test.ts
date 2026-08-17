/**
 * Unit tests: codebase extractor (F2).
 *
 * Extracts committed fixtures under tests/fixtures/code-graph/ (root =
 * tests/fixtures) and asserts EXACT node IDs, labels, kinds, source locations,
 * and every edge relation/weight/from/to in deterministic order. Also covers
 * the Graphify `ids.py` normalization semantics, unknown-suffix emptiness,
 * file-node-only fallbacks, bare-import dropping, ambiguity dropping, and the
 * never-throw contract (truncated fixture + pathological nesting).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/services/code-graph/codebase-extractor.js';
import { makeId, normalizeId } from '../../../src/services/code-graph/ids.js';
import type { CodeEdge, FileExtraction } from '../../../src/services/code-graph/types.js';

/** fixtures root: tests/fixtures → relPaths below are `code-graph/...`. */
const fixturesRoot = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Read a fixture (as Buffer — exercises the Buffer branch) and extract it. */
async function extract(relPath: string): Promise<FileExtraction> {
  const source = await readFile(join(fixturesRoot, relPath));
  return extractFile(fixturesRoot, relPath, source);
}

/** Compact `from | relation | to` view of every edge, in emitted order. */
const edgeLines = (edges: CodeEdge[]): string[] =>
  edges.map((e) => `${e.from} ${e.relation} ${e.to}`);

/** Compact `id | label | kind | L?` view of every node, in emitted order. */
const nodeLines = (nodes: FileExtraction['nodes']): string[] =>
  nodes.map(
    (n) => `${n.id} | ${n.label} | ${n.kind} | ${n.sourceLocation ?? ''}`,
  );

describe('ids — Graphify ids.py semantics', () => {
  it('normalizes unicode, punctuation, casing and underscores', () => {
    expect(normalizeId('Café File 123')).toBe('café_file_123');
    expect(normalizeId('  A--B__C  ')).toBe('a_b_c');
    expect(normalizeId('SNAKE_Case')).toBe('snake_case');
    expect(normalizeId('___')).toBe('');
    expect(normalizeId('')).toBe('');
  });

  it('collapses unicode letters/digits instead of the whole token', () => {
    expect(normalizeId('Δοκιμή 文件.123')).toBe('δοκιμή_文件_123');
  });

  it('is idempotent', () => {
    for (const s of ['Café File', 'A--B__C', 'x.y/z', '___', '路径 文件']) {
      expect(normalizeId(normalizeId(s))).toBe(normalizeId(s));
    }
  });

  it('joins parts with _, stripping edge _ and . per part', () => {
    expect(makeId('_src_', '.services.')).toBe('src_services');
    expect(makeId('Δοκιμή', 'File.ts')).toBe('δοκιμή_file_ts');
    expect(makeId('路径', 'Main')).toBe('路径_main');
    expect(makeId('', '')).toBe('');
    expect(makeId('.._x_', '_y__')).toBe('x_y');
  });
});

describe('extractFile — typescript fixture (code-graph/sample.ts)', () => {
  let result: FileExtraction;
  beforeAll(async () => {
    result = await extract('code-graph/sample.ts');
  });

  it('emits exact node IDs, labels, kinds and source locations', () => {
    expect(result.errors).toEqual([]);
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_sample | sample.ts | file | L1',
      'code_graph_sample_greeter | Greeter | class | L6',
      'code_graph_sample_color | Color | class | L10',
      'code_graph_sample_widgetbox | WidgetBox | class | L15',
      'code_graph_sample_widgetbox_add | .add() | method | L18',
      'code_graph_sample_widgetbox_count | .count() | method | L23',
      'code_graph_sample_createbox | createBox() | function | L28',
      'code_graph_sample_describebox | describeBox() | function | L32',
    ]);
  });

  it('emits every edge with exact relation/from/to, in stable order', () => {
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_sample contains code_graph_sample_greeter',
      'code_graph_sample contains code_graph_sample_color',
      'code_graph_sample contains code_graph_sample_widgetbox',
      'code_graph_sample_widgetbox method code_graph_sample_widgetbox_add',
      'code_graph_sample_widgetbox method code_graph_sample_widgetbox_count',
      'code_graph_sample contains code_graph_sample_createbox',
      'code_graph_sample contains code_graph_sample_describebox',
      'code_graph_sample imports_from code_graph_widget',
      'code_graph_sample imports code_graph_side_effect',
      'code_graph_sample_widgetbox_add calls code_graph_sample_widgetbox_count',
      'code_graph_sample_describebox calls code_graph_sample_createbox',
      'code_graph_sample_describebox calls code_graph_sample_widgetbox_count',
    ]);
  });

  it('marks every edge EXTRACTED/1.0 with the source file', () => {
    expect(result.edges.length).toBeGreaterThan(0);
    for (const edge of result.edges) {
      expect(edge.confidence).toBe('EXTRACTED');
      expect(edge.weight).toBe(1);
      expect(edge.sourceFile).toBe('code-graph/sample.ts');
    }
  });

  it('drops bare-package imports entirely', () => {
    expect(result.nodes.some((n) => n.label === 'lodash')).toBe(false);
    expect(result.edges.some((e) => e.to.includes('lodash'))).toBe(false);
  });

  it('does not emit method nodes for interface method signatures', () => {
    expect(
      result.nodes.filter((n) => n.kind === 'method').map((n) => n.label),
    ).toEqual(['.add()', '.count()']);
  });

  it('attaches sourceFile to every node', () => {
    for (const node of result.nodes) {
      expect(node.sourceFile).toBe('code-graph/sample.ts');
    }
  });
});

describe('extractFile — python fixture (code-graph/sample.py)', () => {
  let result: FileExtraction;
  beforeAll(async () => {
    result = await extract('code-graph/sample.py');
  });

  it('emits exact node IDs, labels, kinds and source locations', () => {
    expect(result.errors).toEqual([]);
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_sample | sample.py | file | L1',
      'code_graph_sample_greeter | Greeter | class | L7',
      'code_graph_sample_greeter_init | .__init__() | method | L10',
      'code_graph_sample_greeter_hello | .hello() | method | L13',
      'code_graph_sample_build_greeter | build_greeter() | function | L17',
      'code_graph_sample_main | main() | function | L21',
    ]);
  });

  it('emits every edge with exact relation/from/to, in stable order', () => {
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_sample contains code_graph_sample_greeter',
      'code_graph_sample_greeter method code_graph_sample_greeter_init',
      'code_graph_sample_greeter method code_graph_sample_greeter_hello',
      'code_graph_sample contains code_graph_sample_build_greeter',
      'code_graph_sample contains code_graph_sample_main',
      'code_graph_sample imports helper',
      'code_graph_sample imports_from helper',
      'code_graph_sample_main calls code_graph_sample_build_greeter',
      'code_graph_sample_main calls code_graph_sample_greeter_hello',
    ]);
  });

  it('drops stdlib imports and cross-file calls (no stub nodes)', () => {
    expect(result.edges.some((e) => e.to === 'os')).toBe(false);
    // `greet` lives in helper.py → same-file call resolution must not invent it
    expect(result.nodes.some((n) => n.label === 'greet()')).toBe(false);
    const callTargets = result.edges
      .filter((e) => e.relation === 'calls')
      .map((e) => e.to);
    expect(callTargets).toEqual([
      'code_graph_sample_build_greeter',
      'code_graph_sample_greeter_hello',
    ]);
  });
});

describe('extractFile — file-node-only fallbacks and unknown suffixes', () => {
  it('extracts markdown as a single file node', async () => {
    const result = await extract('code-graph/notes.md');
    expect(result.errors).toEqual([]);
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_notes | notes.md | file | L1',
    ]);
    expect(result.edges).toEqual([]);
  });

  it('extracts shell as a single file node', async () => {
    const result = await extract('code-graph/run.sh');
    expect(result.errors).toEqual([]);
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_run | run.sh | file | L1',
    ]);
    expect(result.edges).toEqual([]);
  });

  it('extracts json as a single file node', async () => {
    const result = await extractFile(fixturesRoot, 'code-graph/data.json', '{"x": 1}');
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_data | data.json | file | L1',
    ]);
    expect(result.edges).toEqual([]);
  });

  it('returns an empty extraction for unknown suffixes', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/thing.xyz',
      'anything at all',
    );
    expect(result).toEqual({ nodes: [], edges: [], errors: [] });
  });
});

describe('extractFile — ts/js structural coverage', () => {
  it('emits inherits for an in-file unique base class', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/inherit.ts',
      'class Base {}\nclass Derived extends Base {}\n',
    );
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_inherit | inherit.ts | file | L1',
      'code_graph_inherit_base | Base | class | L1',
      'code_graph_inherit_derived | Derived | class | L2',
    ]);
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_inherit contains code_graph_inherit_base',
      'code_graph_inherit contains code_graph_inherit_derived',
      'code_graph_inherit_derived inherits code_graph_inherit_base',
    ]);
  });

  it('drops inherits when the base-class name is ambiguous in-file', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/inherit-ambiguous.ts',
      'interface Base { x: number; }\nclass Base {}\nclass Derived extends Base {}\n',
    );
    expect(result.edges.filter((e) => e.relation === 'inherits')).toEqual([]);
    // duplicate contains edges collapse (same from/relation/to), nodes stay distinct
    expect(result.edges.filter((e) => e.relation === 'contains')).toHaveLength(2);
    expect(result.nodes).toHaveLength(4);
  });

  it('emits function nodes for arrow/function variable declarators only', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/vars.ts',
      'const helper = () => 1;\nconst named = function () { return 2; };\nlist.map(() => 3);\n',
    );
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_vars | vars.ts | file | L1',
      'code_graph_vars_helper | helper() | function | L1',
      'code_graph_vars_named | named() | function | L2',
    ]);
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_vars contains code_graph_vars_helper',
      'code_graph_vars contains code_graph_vars_named',
    ]);
  });

  it('emits type aliases and generator functions as class/function nodes', async () => {
    const alias = await extractFile(
      fixturesRoot,
      'code-graph/alias.ts',
      'type Pair = { a: number };\n',
    );
    expect(nodeLines(alias.nodes)).toEqual([
      'code_graph_alias | alias.ts | file | L1',
      'code_graph_alias_pair | Pair | class | L1',
    ]);
    const gen = await extractFile(
      fixturesRoot,
      'code-graph/gen.ts',
      'function* gen() { yield 1; }\n',
    );
    expect(nodeLines(gen.nodes)).toEqual([
      'code_graph_gen | gen.ts | file | L1',
      'code_graph_gen_gen | gen() | function | L1',
    ]);
  });

  it('resolves dynamic import() and require() to relative files', async () => {
    const dynamic = await extractFile(
      fixturesRoot,
      'code-graph/dynamic.ts',
      "const load = () => import('./widget');\n",
    );
    expect(edgeLines(dynamic.edges)).toEqual([
      'code_graph_dynamic contains code_graph_dynamic_load',
      'code_graph_dynamic imports_from code_graph_widget',
    ]);
    expect(dynamic.edges.some((e) => e.relation === 'calls')).toBe(false);

    const required = await extractFile(
      fixturesRoot,
      'code-graph/req.cjs',
      "const { Widget } = require('./widget');\n",
    );
    expect(nodeLines(required.nodes)).toEqual([
      'code_graph_req | req.cjs | file | L1',
    ]);
    expect(edgeLines(required.edges)).toEqual([
      'code_graph_req imports code_graph_widget',
    ]);
  });

  it('treats export-from as imports_from', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/reexport.ts',
      "export { Widget } from './widget';\n",
    );
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_reexport | reexport.ts | file | L1',
    ]);
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_reexport imports_from code_graph_widget',
    ]);
  });

  it('parses plain js with the javascript grammar and resolves same-file calls', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/plain.js',
      'function top() { return helper(); }\nfunction helper() { return 1; }\n',
    );
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_plain | plain.js | file | L1',
      'code_graph_plain_top | top() | function | L1',
      'code_graph_plain_helper | helper() | function | L2',
    ]);
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_plain contains code_graph_plain_top',
      'code_graph_plain contains code_graph_plain_helper',
      'code_graph_plain_top calls code_graph_plain_helper',
    ]);
  });

  it('extracts jsx and tsx via the tsx grammar', async () => {
    const jsx = await extractFile(
      fixturesRoot,
      'code-graph/view.jsx',
      'const View = () => <div />;\n',
    );
    expect(nodeLines(jsx.nodes)).toEqual([
      'code_graph_view | view.jsx | file | L1',
      'code_graph_view_view | View() | function | L1',
    ]);
    const tsx = await extractFile(
      fixturesRoot,
      'code-graph/el.tsx',
      'export const El = () => <span />;\n',
    );
    expect(nodeLines(tsx.nodes)).toEqual([
      'code_graph_el | el.tsx | file | L1',
      'code_graph_el_el | El() | function | L1',
    ]);
  });

  it('dispatches mjs/mts/cts suffixes to the right grammar', async () => {
    for (const [relPath, id] of [
      ['code-graph/mod.mjs', 'code_graph_mod'],
      ['code-graph/mod.mts', 'code_graph_mod'],
      ['code-graph/mod.cts', 'code_graph_mod'],
    ] as const) {
      const result = await extractFile(fixturesRoot, relPath, 'export const x = 1;\n');
      expect(nodeLines(result.nodes)).toEqual([
        `${id} | ${relPath.slice(relPath.lastIndexOf('/') + 1)} | file | L1`,
      ]);
      expect(result.errors).toEqual([]);
    }
  });

  it('extracts many files concurrently through the shared grammar cache', async () => {
    const relPaths = [
      'code-graph/sample.ts',
      'code-graph/sample.py',
      'code-graph/notes.md',
      'code-graph/run.sh',
    ];
    const sources = await Promise.all(
      relPaths.map((rel) => readFile(join(fixturesRoot, rel))),
    );
    const results = await Promise.all(
      relPaths.map((rel, i) => extractFile(fixturesRoot, rel, sources[i])),
    );
    for (const result of results) {
      expect(result.errors).toEqual([]);
      expect(result.nodes[0].kind).toBe('file');
    }
    expect(results[0].edges.map((e) => e.relation)).toContain('imports_from');
    expect(results[1].nodes.some((n) => n.label === '.hello()')).toBe(true);
    expect(results[2].nodes).toHaveLength(1);
    expect(results[3].nodes).toHaveLength(1);
  });
});

describe('extractFile — python import resolution', () => {
  it('resolves relative from-imports against the importer directory', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/relimport.py',
      'from .sample import main\n',
    );
    expect(edgeLines(result.edges)).toEqual([
      'code_graph_relimport imports_from code_graph_sample',
    ]);
  });

  it('drops unresolvable plain imports', async () => {
    const result = await extractFile(
      fixturesRoot,
      'code-graph/osimport.py',
      'import os\n',
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });
});

describe('extractFile — robustness (never throws)', () => {
  it('returns partial results for truncated/invalid input', async () => {
    const result = await extract('code-graph/sample-invalid.ts');
    expect(result.errors).toEqual([]);
    expect(result.nodes[0]).toMatchObject({
      id: 'code_graph_sample_invalid',
      label: 'sample-invalid.ts',
      kind: 'file',
      sourceLocation: 'L1',
    });
  });

  it('reports errors plus whatever was extracted when the walk fails', async () => {
    // Pathologically deep nesting overflows the recursive walk deterministically
    // (tree-sitter itself parses this fine; the JS walk does not).
    const source = '('.repeat(30000) + ')'.repeat(30000);
    const result = await extractFile(fixturesRoot, 'code-graph/deep.py', source);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/call stack/i);
    expect(nodeLines(result.nodes)).toEqual([
      'code_graph_deep | deep.py | file | L1',
    ]);
    expect(result.edges).toEqual([]);
  });

  it('handles string and Buffer sources identically', async () => {
    const source = 'class Only {}\n';
    const fromBuffer = await extractFile(
      fixturesRoot,
      'code-graph/only.ts',
      Buffer.from(source),
    );
    const fromString = await extractFile(fixturesRoot, 'code-graph/only.ts', source);
    expect(fromBuffer).toEqual(fromString);
    expect(nodeLines(fromBuffer.nodes)).toEqual([
      'code_graph_only | only.ts | file | L1',
      'code_graph_only_only | Only | class | L1',
    ]);
  });
});
