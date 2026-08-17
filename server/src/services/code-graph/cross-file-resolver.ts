/**
 * Cross-file call resolution (F6) — deterministic, conservative resolution of
 * the RawCalls emitted by the extractor against a GLOBAL label index built
 * from (a) the fresh extractions of this sync and (b) the stored nodes of
 * files this sync is NOT replacing (unchanged files, read from
 * `knowledge_nodes`). Faithful to Graphify's
 * `resolve_cross_file_raw_calls` + `build_label_index` methodology:
 *
 *   1. import evidence  — caller file's `imports_from` edge to file F with
 *      exactly one candidate living in F → EXTRACTED (1.0);
 *   2. unique candidate → INFERRED;
 *   3. path proximity (strict unique longest common dir prefix) → INFERRED;
 *   4. otherwise SKIPPED (ambiguous, the god-node guard).
 *
 * Member calls (kind 'method') resolve ONLY via import evidence or global
 * uniqueness — never path proximity (receiver typing is a future feature).
 * The resolver NEVER adds nodes and NEVER guesses: ambiguous calls are
 * skipped, dangling calls are counted and dropped. All ids on emitted edges
 * are BARE extraction ids (the sync layer re-applies the root scope).
 *
 * @see CONTRACT.md §F6
 */

import { resolve } from 'node:path';
import type { Db } from 'mongodb';
import { rootKeyFor } from './code-graph-sync.js';
import { makeId } from './ids.js';
import type {
  CodeEdge,
  CodeNode,
  FileExtraction,
  RawCall,
} from './types.js';

/** One resolvable symbol: its bare node id and the source file it lives in. */
export interface LabelIndexEntry {
  id: string;
  file: string;
}

/** relPath minus its final extension (`a/b.ts` → `a/b`). */
function fileStem(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '');
}

/** Index key per raw-call kind: `name()`, `.name()`, bare class `Name`. */
const INDEX_KEY_FOR_KIND: Record<RawCall['kind'], (callee: string) => string> =
  {
    function: (callee) => `${callee}()`,
    method: (callee) => `.${callee}()`,
    constructor: (callee) => callee,
  };

/**
 * Build the global label index. Keys are the extractor's exact label strings:
 * `name()` for function nodes, `.name()` for method nodes, bare `Name` for
 * class nodes (constructor targets). File and variable nodes never become
 * call targets and are not indexed.
 */
export function buildLabelIndex(
  nodes: CodeNode[],
): Map<string, LabelIndexEntry[]> {
  const index = new Map<string, LabelIndexEntry[]>();
  for (const node of nodes) {
    if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'class') {
      continue;
    }
    const key = node.label;
    if (!key) continue;
    const entry: LabelIndexEntry = { id: node.id, file: node.sourceFile };
    const existing = index.get(key);
    if (existing) existing.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

/** Deduplicate candidates by id, preserving first-occurrence order. */
function dedupeCandidates(candidates: LabelIndexEntry[]): LabelIndexEntry[] {
  const seen = new Set<string>();
  const out: LabelIndexEntry[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

/** Directory segments of a posix relPath (`a/b/x.ts` → [`a`, `b`]). */
function dirSegments(relPath: string): string[] {
  const idx = relPath.lastIndexOf('/');
  const dir = idx < 0 ? '' : relPath.slice(0, idx);
  return dir.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** Longest common leading-segment count between two segment lists. */
function commonPrefixLength(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Strict unique path-proximity winner: the candidate whose file dir shares
 * the longest common prefix with the caller's file dir, resolved only when
 * that maximum is strictly unique (Graphify `_path_proximity_winner`).
 */
function pathProximityWinner(
  callerFile: string,
  candidates: LabelIndexEntry[],
): LabelIndexEntry | null {
  const callDir = dirSegments(callerFile);
  let best = -1;
  let winner: LabelIndexEntry | null = null;
  let tied = false;
  for (const candidate of candidates) {
    const score = commonPrefixLength(callDir, dirSegments(candidate.file));
    if (score > best) {
      best = score;
      winner = candidate;
      tied = false;
    } else if (score === best) {
      tied = true;
    }
  }
  return winner !== null && !tied && best > 0 ? winner : null;
}

/** Append a resolved `calls` edge to the caller file's extraction. */
function pushResolvedEdge(
  extraction: FileExtraction,
  rawCall: RawCall,
  target: LabelIndexEntry,
  confidence: 'EXTRACTED' | 'INFERRED',
  sourceFile: string,
): void {
  const edge: CodeEdge = {
    from: rawCall.caller,
    to: target.id,
    relation: 'calls',
    confidence,
    weight: 1,
    sourceFile,
  };
  if (rawCall.sourceLocation !== undefined) {
    edge.sourceLocation = rawCall.sourceLocation;
  }
  extraction.edges.push(edge);
}

export interface CrossFileResolutionResult {
  resolved: number;
  skippedAmbiguous: number;
  danglingDropped: number;
}

/**
 * Resolve every RawCall in `extractions` against the global index (fresh
 * extraction nodes plus stored nodes of files not being replaced), appending
 * `calls` edges to the caller file's extraction. Deterministic: files are
 * iterated in sorted order and rawCalls in emission order; no randomness.
 *
 * The DB read is best-effort: when it fails the resolver proceeds with the
 * fresh nodes only (a subsequent sync would hit the same DB and fail hard
 * before anything persists).
 */
export async function resolveCrossFileCalls(
  db: Db,
  root: string,
  extractions: Map<string, FileExtraction>,
): Promise<CrossFileResolutionResult> {
  const resolvedRoot = resolve(root);
  const rootKey = rootKeyFor(resolvedRoot);
  const replaced = new Set(extractions.keys());

  const sortedRelPaths = [...extractions.keys()].sort();
  const freshNodes: CodeNode[] = [];
  for (const relPath of sortedRelPaths) {
    freshNodes.push(...(extractions.get(relPath)?.nodes ?? []));
  }

  // Stored nodes of files NOT replaced by this sync stand in for unchanged
  // files. Stored ids are root-scoped (`graphify:<rootKey>:<bareId>`); strip
  // the prefix so the index keys on BARE ids like the extractions do.
  let dbNodes: CodeNode[] = [];
  try {
    const prefix = `graphify:${rootKey}:`;
    const docs = await db
      .collection('knowledge_nodes')
      .find({
        source: 'katra-code',
        'properties.code_root': resolvedRoot,
        'properties.source_file': { $nin: [...replaced] },
      })
      .toArray();
    dbNodes = docs.flatMap((doc): CodeNode[] => {
      const storedId = doc.id;
      const sourceFile = doc.properties?.source_file;
      if (
        typeof storedId !== 'string' ||
        !storedId.startsWith(prefix) ||
        typeof sourceFile !== 'string'
      ) {
        return [];
      }
      return [
        {
          id: storedId.slice(prefix.length),
          label: String(doc.name ?? ''),
          kind: doc.type as CodeNode['kind'],
          sourceFile,
        },
      ];
    });
  } catch {
    dbNodes = []; // best-effort: DB unavailable → fresh nodes only
  }

  const index = buildLabelIndex([...freshNodes, ...dbNodes]);

  let resolved = 0;
  let skippedAmbiguous = 0;
  let danglingDropped = 0;

  for (const relPath of sortedRelPaths) {
    const extraction = extractions.get(relPath);
    if (!extraction) continue;
    // Import evidence: every `imports_from` edge of this file points at the
    // BARE file id of the imported module.
    const importedFileIds = new Set(
      extraction.edges
        .filter((edge) => edge.relation === 'imports_from')
        .map((edge) => edge.to),
    );
    const candidateMatchesImport = (candidate: LabelIndexEntry): boolean => {
      const stemId = makeId(fileStem(candidate.file));
      for (const imported of importedFileIds) {
        if (
          candidate.id === imported ||
          stemId === imported ||
          candidate.id.startsWith(`${imported}_`)
        ) {
          return true;
        }
      }
      return false;
    };

    for (const rawCall of extraction.rawCalls ?? []) {
      const callee = rawCall.callee.trim();
      const key = INDEX_KEY_FOR_KIND[rawCall.kind](callee);
      const candidates = dedupeCandidates(index.get(key) ?? []);
      if (candidates.length === 0) {
        danglingDropped++;
        continue;
      }

      // 1. Import evidence: exactly one candidate in an imported file.
      const importMatches = candidates.filter(candidateMatchesImport);
      if (importMatches.length === 1) {
        pushResolvedEdge(extraction, rawCall, importMatches[0], 'EXTRACTED', relPath);
        resolved++;
        continue;
      }

      // 2. Unique global candidate → INFERRED.
      if (candidates.length === 1) {
        pushResolvedEdge(extraction, rawCall, candidates[0], 'INFERRED', relPath);
        resolved++;
        continue;
      }

      // 3. Member calls stay conservative: no proximity guessing (F7 receiver
      //    typing would be required to disambiguate receivers).
      if (rawCall.kind === 'method') {
        skippedAmbiguous++;
        continue;
      }

      // 4. Path proximity: strict unique winner only.
      const winner = pathProximityWinner(relPath, candidates);
      if (winner !== null) {
        pushResolvedEdge(extraction, rawCall, winner, 'INFERRED', relPath);
        resolved++;
      } else {
        skippedAmbiguous++;
      }
    }
  }

  return { resolved, skippedAmbiguous, danglingDropped };
}
