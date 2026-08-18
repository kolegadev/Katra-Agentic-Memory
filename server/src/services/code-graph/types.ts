/**
 * Shared types for the Katra-native code graph pipeline (F1 owns this file;
 * later features import from it).
 *
 * @see CONTRACT.md §Interfaces
 */

export interface FileState {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface ScanManifest {
  root: string;
  updatedAt: string;
  files: Record<string, FileState>;
}

export interface ScannedFile {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  hash: string;
  language: string;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface FileChange {
  relPath: string;
  kind: ChangeKind;
  hash?: string;
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  total: number;
}

export type CodeNodeKind =
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'variable';

export interface CodeNode {
  id: string;
  label: string;
  kind: CodeNodeKind;
  sourceFile: string;
  sourceLocation?: string;
  /**
   * F8: declared return type of a TS/TSX/JS function or method, reduced to
   * the last segment of the annotation with generics stripped (same rules
   * as the F7 receiver facts). Absent for builtins/unions and Python.
   */
  returnType?: string;
}

export type CodeRelation =
  | 'contains'
  | 'method'
  | 'imports'
  | 'imports_from'
  | 'calls'
  | 'references'
  | 'inherits';

export interface CodeEdge {
  from: string;
  to: string;
  relation: CodeRelation;
  confidence: 'EXTRACTED' | 'INFERRED';
  weight: number;
  sourceFile: string;
  sourceLocation?: string;
}

/**
 * An unresolved in-file call (F6): emitted instead of being dropped so the
 * cross-file resolver can attempt a conservative global resolution. Callee is
 * the bare name (no `()`, no leading `.`); caller is the enclosing
 * function/method node id, or the file node id for top-level call sites.
 *
 * F7: TS/JS member calls additionally carry receiver facts when the receiver
 * object's type is statically resolvable WITHIN the file (`s.count()` where
 * `const s: Store = ...`, `new Store()`, a typed parameter, same-file
 * return-type flow, or a bare `this`). `name` is the full object-expression
 * text (used for reporting); resolution keys on `typeName`. A receiver is
 * omitted entirely when the type is unknown — the F6 skip behavior applies.
 */
export interface RawCall {
  caller: string;
  callee: string;
  kind: 'function' | 'method' | 'constructor';
  sourceLocation?: string;
  receiver?: {
    name: string;
    typeName?: string;
    typeSource: 'annotation' | 'new' | 'parameter' | 'return_flow' | 'this';
    /**
     * F8: bare callee name of a call initializer (`const x = f()` → `f`)
     * when the extractor cannot resolve f's return type within the file.
     * Present only when `typeName` is absent; resolved cross-file by the
     * return-type index (one propagation hop, never persisted).
     */
    initializerCall?: string;
  };
}

export interface FileExtraction {
  nodes: CodeNode[];
  edges: CodeEdge[];
  errors: string[];
  /** Unresolved in-file calls (F6); omitted when there are none. */
  rawCalls?: RawCall[];
}

export interface SyncResult {
  root: string;
  scanned: number;
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
  extracted: number;
  failed: string[];
  nodesUpserted: number;
  edgesUpserted: number;
  nodesRetracted: number;
  edgesRetracted: number;
  /** Edges dropped at sync time because a stored endpoint id has no node. */
  edgesDropped: number;
}
