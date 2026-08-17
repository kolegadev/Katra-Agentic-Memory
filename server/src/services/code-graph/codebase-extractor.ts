/**
 * Codebase extractor (F2) — deterministic structural extraction from a single
 * source file via tree-sitter (web-tree-sitter + WASM grammars).
 *
 * LanguageConfig-driven walk (Graphify `LanguageConfig` concept): per-language
 * class/function/method node types, import handling, and call detection.
 * Emitted IDs follow the Graphify-compatible scheme in `ids.ts`; unresolved
 * externals produce NO node (never a stub). The function never throws: parse
 * or grammar failures surface as `errors` entries alongside whatever was
 * extracted before the failure (shrink-guard contract, CONTRACT.md §F2).
 */

import { statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';
import { loadGrammar } from './grammars.js';
import type { GrammarKind } from './grammars.js';
import { makeId } from './ids.js';
import type {
  CodeEdge,
  CodeNode,
  CodeRelation,
  FileExtraction,
  RawCall,
} from './types.js';

/* ── per-language configuration ────────────────────────────────────────── */

interface LanguageConfig {
  /** Grammar to parse with. */
  grammar: GrammarKind;
  /** Node types emitted as class-kind nodes. */
  classTypes: ReadonlySet<string>;
  /** Top-level node types emitted as function-kind nodes. */
  functionTypes: ReadonlySet<string>;
  /** Node types emitted as method-kind nodes when found in a class body. */
  methodTypes: ReadonlySet<string>;
  /** Node types representing calls (call resolution pass). */
  callTypes: ReadonlySet<string>;
  /** Node types representing constructor calls (`new X(...)`, JS/TS only). */
  constructorTypes: ReadonlySet<string>;
  /** Declaration containers whose variable_declarator children may hold function values. */
  variableContainers: ReadonlySet<string>;
  /** Base-class names for an emitted class node (inherits pass). */
  baseNames(node: Node): string[];
  /** Callee name of a call node, or null when unresolvable. */
  calleeName(node: Node): string | null;
  /** Emit file-level import edges found anywhere in the tree. */
  emitImports(rootNode: Node, state: ExtractionState): void;
}

/** JS/TS call: `identifier` callee or the property segment of a `member_expression`. */
function calleeNameJS(node: Node): string | null {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const property = fn.childForFieldName('property');
    return property ? property.text : null;
  }
  return null;
}

/** Python call: `identifier` callee or the attribute segment of an `attribute`. */
function calleeNamePY(node: Node): string | null {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? attr.text : null;
  }
  return null;
}

/** Name of an extends-clause value: plain identifier or last segment of a qualified name. */
function baseTypeName(node: Node): string | null {
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    return node.text;
  }
  if (node.type === 'member_expression') {
    const property = node.childForFieldName('property');
    if (property) return property.text;
  }
  return null;
}

/** TS/TSX base-class names from the `class_heritage` child's `extends_clause` values. */
function baseNamesTS(node: Node): string[] {
  const heritage = node.namedChildren.find((c) => c.type === 'class_heritage');
  if (!heritage) return [];
  const names: string[] = [];
  for (const clause of heritage.namedChildren) {
    if (clause.type !== 'extends_clause') continue;
    for (const value of clause.namedChildren) {
      const name = baseTypeName(value);
      if (name) names.push(name);
    }
  }
  return names;
}

/** Python base-class names from the `superclasses` argument list. */
function baseNamesPY(node: Node): string[] {
  const supers = node.childForFieldName('superclasses');
  if (!supers) return [];
  return supers.namedChildren
    .filter((child) => child.type === 'identifier')
    .map((child) => child.text);
}

/* ── import handling ───────────────────────────────────────────────────── */

/** Strip one layer of surrounding `'`/`"` from a string literal's raw text. */
function unquote(text: string): string {
  if (
    text.length >= 2 &&
    ((text[0] === "'" && text[text.length - 1] === "'") ||
      (text[0] === '"' && text[text.length - 1] === '"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Is a specifier file-relative (`./x`, `../x`, `.`, `..`)? */
function isRelativeSpecifier(specifier: string): boolean {
  return /^\.{1,2}(?:\/|$)/.test(specifier);
}

/** Posix dirname of a posix relPath (`code-graph/a.ts` → `code-graph`, `a.ts` → `.`). */
function posixDirname(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '.' : relPath.slice(0, idx);
}

/** Posix relPath of `abs` under `root`, or null when outside root. */
function posixRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs).split(sep).join('/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

/** relPath minus its final extension (`a/b.ts` → `a/b`). */
function fileStem(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '');
}

/** First real file among candidate paths that lives under `root`; null when none do. */
function firstExistingFile(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    let st;
    try {
      st = statSync(candidate);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const rel = posixRelative(root, candidate);
    if (rel) return rel;
  }
  return null;
}

const JS_RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mts', '.cts', '.jsx'];
const JS_INDEX_FILES = ['index', ...JS_RESOLVE_EXTENSIONS.map((ext) => `index${ext}`)];
const JS_SPECIFIER_EXTENSION = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;

/** Resolve a relative JS/TS specifier to a real file relPath under `root`. */
function resolveJsSpecifier(root: string, relPath: string, specifier: string): string | null {
  const base = join(root, posixDirname(relPath), specifier);
  const candidates = [
    base,
    ...JS_RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...JS_INDEX_FILES.map((name) => join(base, name)),
  ];
  // TS-style resolution (Graphify `_resolve_js_import_path`): specifiers carrying a
  // known JS/TS extension usually target source files that do not exist under that
  // exact name (`./connection.js` → `connection.ts`). Probe the stem with all known
  // extensions after the literal path, preserving exact-match precedence.
  const extMatch = specifier.match(JS_SPECIFIER_EXTENSION);
  if (extMatch) {
    const stemBase = base.slice(0, base.length - extMatch[0].length);
    candidates.push(
      stemBase,
      ...JS_RESOLVE_EXTENSIONS.map((ext) => `${stemBase}${ext}`),
      ...JS_INDEX_FILES.map((name) => join(stemBase, name)),
    );
  }
  return firstExistingFile(root, candidates);
}

/** Resolve a dotted Python module path to a real `.py` (or `__init__.py`) under `root`. */
function resolvePyModule(root: string, moduleBase: string): string | null {
  return firstExistingFile(root, [
    `${moduleBase}.py`,
    join(moduleBase, '__init__.py'),
  ]);
}

/** JS/TS import edges: import/export-from statements, `require(...)`, dynamic `import(...)`. */
function emitImportsJS(rootNode: Node, state: ExtractionState): void {
  const interesting = new Set([
    'import_statement',
    'export_statement',
    'call_expression',
  ]);
  for (const node of findNodes(rootNode, interesting)) {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const source = node.childForFieldName('source');
      if (!source) continue; // plain `export {x}` without a from-clause
      const specifier = unquote(source.text);
      if (!isRelativeSpecifier(specifier)) continue; // bare specifier → drop
      const resolved = resolveJsSpecifier(state.root, state.relPath, specifier);
      if (!resolved) continue;
      // `import_clause` is a plain child (not a field) in the TS/JS grammars.
      const hasImportClause = node.namedChildren.some(
        (child) => child.type === 'import_clause',
      );
      const relation: CodeRelation =
        node.type === 'import_statement' && !hasImportClause
          ? 'imports' // side-effect `import 'y'`
          : 'imports_from'; // `import {x} from 'y'`, `import x from 'y'`, `export ... from 'y'`
      pushEdge(state, state.fileId, makeId(fileStem(resolved)), relation);
    } else {
      const fn = node.childForFieldName('function');
      const isRequire = fn?.type === 'identifier' && fn.text === 'require';
      const isDynamicImport = fn?.type === 'import';
      if (!isRequire && !isDynamicImport) continue;
      const args = node.childForFieldName('arguments');
      const first = args?.namedChildren[0];
      if (!first || first.type !== 'string') continue;
      const specifier = unquote(first.text);
      if (!isRelativeSpecifier(specifier)) continue;
      const resolved = resolveJsSpecifier(state.root, state.relPath, specifier);
      if (!resolved) continue;
      pushEdge(
        state,
        state.fileId,
        makeId(fileStem(resolved)),
        isRequire ? 'imports' : 'imports_from',
      );
    }
  }
}

/** Python import edges: `import a.b` and `from [..]x import y` resolved against `root`. */
function emitImportsPY(rootNode: Node, state: ExtractionState): void {
  const interesting = new Set(['import_statement', 'import_from_statement']);
  for (const node of findNodes(rootNode, interesting)) {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        let moduleName: string | null = null;
        if (child.type === 'dotted_name') moduleName = child.text;
        else if (child.type === 'aliased_import') {
          moduleName = child.childForFieldName('name')?.text ?? null;
        }
        if (!moduleName) continue;
        const resolved = resolvePyModule(
          state.root,
          join(state.root, ...moduleName.split('.')),
        );
        if (resolved) {
          pushEdge(state, state.fileId, makeId(fileStem(resolved)), 'imports');
        }
      }
    } else if (node.type === 'import_from_statement') {
      const moduleName = node.childForFieldName('module_name');
      if (!moduleName) continue;
      let level = 0;
      let name = '';
      if (moduleName.type === 'relative_import') {
        const dots = moduleName.text.match(/^\.+/)?.[0].length ?? 0;
        level = dots;
        name = moduleName.text.slice(dots);
      } else if (moduleName.type === 'dotted_name') {
        name = moduleName.text;
      } else {
        continue;
      }
      // level 0 → absolute from the scan root; level N → importer dir up N-1.
      const dirSegments = state.relPath.split('/').slice(0, -1);
      const baseSegments =
        level === 0 ? [] : dirSegments.slice(0, dirSegments.length - (level - 1));
      const base = join(state.root, ...baseSegments);
      const moduleBase = name === '' ? base : join(base, ...name.split('.'));
      const resolved = firstExistingFile(
        state.root,
        name === ''
          ? [join(moduleBase, '__init__.py')]
          : [`${moduleBase}.py`, join(moduleBase, '__init__.py')],
      );
      if (resolved) {
        pushEdge(state, state.fileId, makeId(fileStem(resolved)), 'imports_from');
      }
    }
  }
}

/* ── tree helpers ──────────────────────────────────────────────────────── */

/** DFS over `node` (pre-order), collecting nodes whose type is in `types`. */
function findNodes(node: Node, types: ReadonlySet<string>, out: Node[] = []): Node[] {
  if (types.has(node.type)) out.push(node);
  for (const child of node.namedChildren) findNodes(child, types, out);
  return out;
}

/** Unwrap export/decorator wrappers to the definition node they carry. */
function unwrapDefinition(node: Node): Node {
  if (node.type === 'decorated_definition') {
    const definition = node.childForFieldName('definition');
    if (definition) return definition;
  }
  if (node.type === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration) return declaration;
  }
  return node;
}

/* ── extraction state and emission ─────────────────────────────────────── */

interface ExtractionState {
  root: string;
  /** Posix, normalized relPath of the file being extracted. */
  relPath: string;
  /** relPath minus extension (posix); base for symbol IDs. */
  stem: string;
  fileId: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  /** Call-resolution index: label (`name()` / `.name()`) → node IDs. */
  labelIndex: Map<string, string[]>;
  /** Inherits-resolution index: class name → node IDs. */
  classLabels: Map<string, string[]>;
  /** Function/method bodies to scan for calls, in definition order. */
  callQueue: { callerId: string; body: Node }[];
  /** Unresolved in-file calls (F6), in emission order. */
  rawCalls: RawCall[];
  /** Pending base-class references, in definition order. */
  inheritsQueue: { classId: string; baseName: string }[];
}

function pushEdge(
  state: ExtractionState,
  from: string,
  to: string,
  relation: CodeRelation,
): void {
  state.edges.push({
    from,
    to,
    relation,
    confidence: 'EXTRACTED',
    weight: 1,
    sourceFile: state.relPath,
  });
}

function pushIndex(index: Map<string, string[]>, key: string, id: string): void {
  const ids = index.get(key);
  if (ids) ids.push(id);
  else index.set(key, [id]);
}

/** `L{n}` source location (1-based start row) of a tree-sitter node. */
function sourceLocation(node: Node): string {
  return `L${node.startPosition.row + 1}`;
}

function emitClass(
  node: Node,
  cfg: LanguageConfig,
  state: ExtractionState,
): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;
  const id = makeId(state.stem, name);
  state.nodes.push({
    id,
    label: name,
    kind: 'class',
    sourceFile: state.relPath,
    sourceLocation: sourceLocation(node),
  });
  pushEdge(state, state.fileId, id, 'contains');
  pushIndex(state.classLabels, name, id);
  for (const baseName of cfg.baseNames(node)) {
    state.inheritsQueue.push({ classId: id, baseName });
  }
  const body = node.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    const definition = unwrapDefinition(child);
    if (cfg.methodTypes.has(definition.type) || cfg.functionTypes.has(definition.type)) {
      emitMethod(definition, id, cfg, state);
    }
  }
}

function emitMethod(
  node: Node,
  classId: string,
  cfg: LanguageConfig,
  state: ExtractionState,
): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;
  const id = makeId(classId, name);
  state.nodes.push({
    id,
    label: `.${name}()`,
    kind: 'method',
    sourceFile: state.relPath,
    sourceLocation: sourceLocation(node),
  });
  pushEdge(state, classId, id, 'method');
  pushIndex(state.labelIndex, `.${name}()`, id);
  const body = node.childForFieldName('body');
  if (body) state.callQueue.push({ callerId: id, body });
}

function emitFunction(
  node: Node,
  cfg: LanguageConfig,
  state: ExtractionState,
  nameOverride?: string,
): void {
  const name = nameOverride ?? node.childForFieldName('name')?.text;
  if (!name) return;
  const id = makeId(state.stem, name);
  state.nodes.push({
    id,
    label: `${name}()`,
    kind: 'function',
    sourceFile: state.relPath,
    sourceLocation: sourceLocation(node),
  });
  pushEdge(state, state.fileId, id, 'contains');
  pushIndex(state.labelIndex, `${name}()`, id);
  const body = node.childForFieldName('body');
  if (body) state.callQueue.push({ callerId: id, body });
}

/** Pass 1: file children → class/function/method nodes + contains/method edges. */
function emitDefinitions(rootNode: Node, cfg: LanguageConfig, state: ExtractionState): void {
  for (const child of rootNode.namedChildren) {
    const definition = unwrapDefinition(child);
    if (cfg.classTypes.has(definition.type)) {
      emitClass(definition, cfg, state);
    } else if (cfg.functionTypes.has(definition.type)) {
      emitFunction(definition, cfg, state);
    } else if (cfg.variableContainers.has(definition.type)) {
      for (const declarator of definition.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');
        if (!name || name.type !== 'identifier' || !value) continue;
        if (value.type === 'arrow_function' || value.type === 'function_expression') {
          emitFunction(value, cfg, state, name.text);
        }
      }
    }
  }
}

/** Pass 3: class `inherits` edges for in-file unique base-class matches. */
function emitInherits(state: ExtractionState): void {
  for (const { classId, baseName } of state.inheritsQueue) {
    const candidates = state.classLabels.get(baseName);
    if (candidates && candidates.length === 1) {
      pushEdge(state, classId, candidates[0], 'inherits');
    }
  }
}

/** Bare callee name + kind of a call node, or null when unresolvable (F6). */
function rawCallFacts(
  cfg: LanguageConfig,
  call: Node,
): { callee: string; kind: RawCall['kind'] } | null {
  if (cfg.constructorTypes.has(call.type)) {
    const ctor = call.childForFieldName('constructor');
    if (!ctor) return null;
    return { callee: ctor.text, kind: 'constructor' };
  }
  const callee = cfg.calleeName(call);
  if (!callee) return null;
  const fn = call.childForFieldName('function');
  const kind =
    fn && (fn.type === 'member_expression' || fn.type === 'attribute')
      ? 'method'
      : 'function';
  return { callee, kind };
}

/** Append an unresolved call as a RawCall (F6: never invent a stub node). */
function pushRawCall(
  state: ExtractionState,
  callerId: string,
  call: Node,
  cfg: LanguageConfig,
): void {
  const facts = rawCallFacts(cfg, call);
  if (!facts) return;
  state.rawCalls.push({
    caller: callerId,
    callee: facts.callee,
    kind: facts.kind,
    sourceLocation: sourceLocation(call),
  });
}

/** In-file resolved targets of a call callee (union of `f()` / `.f()` hits). */
function inFileTargets(state: ExtractionState, callee: string): Set<string> {
  const targets = new Set<string>();
  for (const id of state.labelIndex.get(`${callee}()`) ?? []) targets.add(id);
  for (const id of state.labelIndex.get(`.${callee}()`) ?? []) targets.add(id);
  return targets;
}

/**
 * Pass 4: same-file `calls` edges via the per-file label index (unique hits
 * only). Calls that do not resolve in-file become RawCalls (F6) instead of
 * being dropped — including constructor calls, which in-file resolution never
 * handles, and top-level calls, whose caller is the file node.
 */
function emitCalls(
  cfg: LanguageConfig,
  state: ExtractionState,
  rootNode: Node,
): void {
  const bodyCallIds = new Set<number>();
  for (const { callerId, body } of state.callQueue) {
    for (const call of findNodes(body, cfg.callTypes)) {
      bodyCallIds.add(call.id);
      const callee = cfg.calleeName(call);
      if (!callee) continue;
      const targets = inFileTargets(state, callee);
      if (targets.size === 1) {
        pushEdge(state, callerId, [...targets][0], 'calls');
      } else {
        pushRawCall(state, callerId, call, cfg);
      }
    }
    for (const call of findNodes(body, cfg.constructorTypes)) {
      bodyCallIds.add(call.id);
      pushRawCall(state, callerId, call, cfg);
    }
  }
  // Top-level call sites (outside any emitted function/method body): the
  // file node is the caller. Resolved-in-file top-level calls keep today's
  // behavior (no edge), unresolved ones become RawCalls.
  for (const call of findNodes(rootNode, cfg.callTypes)) {
    if (bodyCallIds.has(call.id)) continue;
    const callee = cfg.calleeName(call);
    if (!callee) continue;
    const targets = inFileTargets(state, callee);
    if (targets.size !== 1) pushRawCall(state, state.fileId, call, cfg);
  }
  for (const call of findNodes(rootNode, cfg.constructorTypes)) {
    if (bodyCallIds.has(call.id)) continue;
    pushRawCall(state, state.fileId, call, cfg);
  }
}

/** Dedupe edges by from|relation|to, preserving first-occurrence order. */
function dedupeEdges(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  const out: CodeEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.relation}\u0000${edge.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(edge);
    }
  }
  return out;
}

/* ── language configs and suffix dispatch ──────────────────────────────── */

const TS_CONFIG: LanguageConfig = {
  grammar: 'typescript',
  classTypes: new Set([
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
  ]),
  functionTypes: new Set(['function_declaration', 'generator_function_declaration']),
  methodTypes: new Set(['method_definition']),
  callTypes: new Set(['call_expression']),
  constructorTypes: new Set(['new_expression']),
  variableContainers: new Set(['variable_declaration', 'lexical_declaration']),
  baseNames: baseNamesTS,
  calleeName: calleeNameJS,
  emitImports: emitImportsJS,
};

const JS_CONFIG: LanguageConfig = {
  ...TS_CONFIG,
  grammar: 'javascript',
  classTypes: new Set(['class_declaration']),
};

const PY_CONFIG: LanguageConfig = {
  grammar: 'python',
  classTypes: new Set(['class_definition']),
  functionTypes: new Set(['function_definition']),
  methodTypes: new Set(), // Python methods are `function_definition` inside a class body
  callTypes: new Set(['call']),
  constructorTypes: new Set(), // Python has no `new`; class instantiation stays a plain call
  variableContainers: new Set(),
  baseNames: baseNamesPY,
  calleeName: calleeNamePY,
  emitImports: emitImportsPY,
};

interface LanguageEntry {
  grammar: GrammarKind;
  config: LanguageConfig;
}

/** Suffix → language entry; `null` = file-node-only fallback (json/md/sh). */
const SUFFIX_LANGUAGES: Record<string, LanguageEntry | null> = {
  ts: { grammar: 'typescript', config: TS_CONFIG },
  tsx: { grammar: 'tsx', config: TS_CONFIG },
  mts: { grammar: 'typescript', config: TS_CONFIG },
  cts: { grammar: 'typescript', config: TS_CONFIG },
  js: { grammar: 'javascript', config: JS_CONFIG },
  jsx: { grammar: 'tsx', config: TS_CONFIG }, // JSX needs the tsx grammar
  mjs: { grammar: 'javascript', config: JS_CONFIG },
  cjs: { grammar: 'javascript', config: JS_CONFIG },
  py: { grammar: 'python', config: PY_CONFIG },
  json: null,
  md: null,
  sh: null,
};

/* ── entry point ───────────────────────────────────────────────────────── */

/**
 * Extract the structural code graph of one source file: file/class/function/
 * method nodes and contains/method/imports/imports_from/inherits/calls edges
 * with Graphify-compatible IDs. Never throws: failures are reported through
 * `errors` with whatever was extracted before the failure. Unknown suffixes
 * yield an empty extraction; `.json`/`.md`/`.sh` yield a file node only.
 */
export async function extractFile(
  root: string,
  relPath: string,
  source: string | Buffer,
): Promise<FileExtraction> {
  const rel = relPath.replace(/\\/g, '/');
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  const entry = SUFFIX_LANGUAGES[ext];
  if (entry === undefined) return { nodes: [], edges: [], errors: [] };
  const stem = fileStem(rel);
  const fileId = makeId(stem);
  const nodes: CodeNode[] = [
    {
      id: fileId,
      label: rel.slice(rel.lastIndexOf('/') + 1),
      kind: 'file',
      sourceFile: rel,
      sourceLocation: 'L1',
    },
  ];
  if (entry === null) return { nodes, edges: [], errors: [] };
  const edges: CodeEdge[] = [];
  const state: ExtractionState = {
    root,
    relPath: rel,
    stem,
    fileId,
    nodes,
    edges,
    labelIndex: new Map(),
    classLabels: new Map(),
    callQueue: [],
    rawCalls: [],
    inheritsQueue: [],
  };
  try {
    const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
    const language = await loadGrammar(entry.grammar);
    const parser = new Parser();
    let tree: Tree | null = null;
    try {
      parser.setLanguage(language);
      tree = parser.parse(text);
      if (!tree) throw new Error(`tree-sitter produced no tree for ${rel}`);
      emitDefinitions(tree.rootNode, entry.config, state);
      entry.config.emitImports(tree.rootNode, state);
      emitInherits(state);
      emitCalls(entry.config, state, tree.rootNode);
    } finally {
      tree?.delete();
      parser.delete();
    }
    const extraction: FileExtraction = { nodes, edges: dedupeEdges(edges), errors: [] };
    if (state.rawCalls.length > 0) extraction.rawCalls = state.rawCalls;
    return extraction;
  } catch (err) {
    const extraction: FileExtraction = {
      nodes,
      edges: dedupeEdges(edges),
      errors: [err instanceof Error ? err.message : String(err)],
    };
    if (state.rawCalls.length > 0) extraction.rawCalls = state.rawCalls;
    return extraction;
  }
}
