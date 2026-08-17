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
 */
export interface RawCall {
  caller: string;
  callee: string;
  kind: 'function' | 'method' | 'constructor';
  sourceLocation?: string;
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
}
