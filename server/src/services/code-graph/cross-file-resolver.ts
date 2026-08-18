/**
 * Cross-file call resolution (F6+F7) — deterministic, conservative resolution
 * of the RawCalls emitted by the extractor against a GLOBAL label index built
 * from (a) the fresh extractions of this sync and (b) the stored nodes of
 * files this sync is NOT replacing (unchanged files, read from
 * `knowledge_nodes`). Faithful to Graphify's
 * `resolve_cross_file_raw_calls` + `build_label_index` methodology:
 *
 *   1. import evidence  — caller file's `imports_from` edge to file F with
 *      exactly one candidate living in F → EXTRACTED (1.0);
 *   2. non-test preference (Graphify `disambiguate_ambiguous_candidates`
 *      stage 1, `paths.py`): a NON-test caller drops candidates living in
 *      test files before ANY further disambiguation, so test mocks/stubs
 *      never shadow real symbols or win proximity tiebreaks; a test caller
 *      keeps the full candidate set (test-local resolution allowed);
 *   3. unique candidate → INFERRED;
 *   4. path proximity (strict unique longest common dir prefix) → INFERRED;
 *   5. otherwise SKIPPED (ambiguous, the god-node guard).
 *
 * Member calls (kind 'method') resolve ONLY via import evidence or global
 * uniqueness — never path proximity — EXCEPT F7 typed member calls: a member
 * call whose rawCall carries receiver facts with a `typeName` resolves via a
 * global class-name index (import-bound preference, else unique global class),
 * emitting `calls` to the `${classId}_${callee}` method node ONLY when that
 * method node exists (never invented). Confidence is EXTRACTED for
 * annotation/new/parameter/this receivers and INFERRED for return_flow.
 *
 * F8 extends F7 to cross-file return-type propagation: a receiver whose
 * initializer call has no in-file type (`const svc = getService(); …`) is
 * looked up in a global return-type index and resolved through the same
 * class-name path. A successful F8 resolution consumes the call; an F8
 * lookup failure FALLS THROUGH to the name-based ladder, whose uniqueness
 * requirement keeps the god-node guard intact.
 *
 * The resolver NEVER adds nodes and NEVER guesses: ambiguous calls are
 * skipped, dangling calls are counted and dropped. All ids on emitted edges
 * are BARE extraction ids (the sync layer re-applies the root scope).
 *
 * @see CONTRACT.md §F6, §F7
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

/** F8: one declared return type for a function label, with its source file. */
export interface ReturnTypeIndexEntry {
  typeName: string;
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

/**
 * Class-name index (F7): class-kind nodes keyed by their bare class label —
 * the lookup target for receiver `typeName`s. Built alongside
 * {@link buildLabelIndex} from the same node set (fresh + stored).
 */
export function buildClassIndex(
  nodes: CodeNode[],
): Map<string, LabelIndexEntry[]> {
  const index = new Map<string, LabelIndexEntry[]>();
  for (const node of nodes) {
    if (node.kind !== 'class') continue;
    const label = node.label;
    if (!label) continue;
    const entry: LabelIndexEntry = { id: node.id, file: node.sourceFile };
    const existing = index.get(label);
    if (existing) existing.push(entry);
    else index.set(label, [entry]);
  }
  return index;
}

/**
 * Return-type index (F8): function nodes that declare a `returnType`, keyed
 * by their exact label (`name()`). Built from the same node set as the label
 * index (fresh extractions + stored nodes of unchanged files) — the basis
 * for cross-file return-type propagation of call-initializer receivers.
 * Method nodes never enter this index (their labels are `.name()`).
 */
export function buildReturnTypeIndex(
  nodes: CodeNode[],
): Map<string, ReturnTypeIndexEntry[]> {
  const index = new Map<string, ReturnTypeIndexEntry[]>();
  for (const node of nodes) {
    if (node.kind !== 'function' || !node.returnType) continue;
    const key = node.label;
    if (!key) continue;
    const entry: ReturnTypeIndexEntry = { typeName: node.returnType, file: node.sourceFile };
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

/**
 * Path segments that, when they appear as a WHOLE path component, mark the
 * path as a test location (Graphify `_TEST_DIR_SEGMENTS` in paths.py).
 * Matched against segments, never raw substrings, so `src/contest.py` and
 * `src/latest/x.py` do NOT match.
 */
const TEST_DIR_SEGMENTS = new Set([
  'tests',
  'test',
  'spec',
  'specs',
  '__tests__',
]);

/**
 * Filename patterns marking a file as a test, matched against the filename
 * only (Graphify `_TEST_FILENAME_PATTERNS` in paths.py). The first five are
 * case-insensitive; the Java/C# conventions are case-sensitive (require an
 * uppercase-led `Test`/`Tests` before the extension).
 */
const TEST_FILENAME_PATTERNS: RegExp[] = [
  /^test_.*/i,
  /.*_test\..+$/i,
  /.*\.test\..+$/i,
  /.*\.spec\..+$/i,
  /.*_spec\..+$/i,
  /.*\.tests\.ps1$/i,
  /.*Test\.java$/,
  /.*Tests\.java$/,
  /.*Tests\.cs$/,
];

/**
 * Classify a source path as a test path (case-insensitive, segment-aware) —
 * a faithful port of Graphify `_is_test_path` (paths.py). A path is a test
 * path when any whole path segment equals a known test dir name
 * (`tests`/`test`/`spec`/`specs`/`__tests__`) or the filename matches a
 * known test-file naming convention (`test_*.ts`, `*_test.ts`, `*.test.ts`,
 * `*.spec.ts`, `*_spec.ts`, `*.Tests.ps1`, `*Test.java`, `*Tests.java`,
 * `*Tests.cs`). Conservative on purpose: `latest.py`, `src/contest.py` and
 * `test-utils.ts` are NON-test.
 */
export function isTestPath(relPath: string): boolean {
  if (!relPath) return false;
  // Accept both POSIX and Windows separators (Graphify normalizes the same).
  const norm = relPath.replace(/\\/g, '/');
  const segments = norm.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (TEST_DIR_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  const filename = segments[segments.length - 1] ?? '';
  if (!filename) return false;
  return TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Graphify `disambiguate_ambiguous_candidates` stage 1: a NON-test call
 * site drops candidates living in test files (test mocks/stubs must not
 * shadow real symbols); a test call site keeps the full candidate set
 * (test-local resolution allowed). Order-preserving, so determinism is
 * unchanged. Single candidates are returned as-is (Graphify short-circuits
 * the single-candidate case before the test filter).
 */
export function preferNonTest<T extends { file: string }>(
  candidates: T[],
  callerFile: string,
): T[] {
  if (candidates.length <= 1) return candidates;
  if (isTestPath(callerFile)) return candidates;
  return candidates.filter((candidate) => !isTestPath(candidate.file));
}

/**
 * F7/F8 class-name choice: import evidence first (an explicit import
 * binding wins regardless of test/non-test — Graphify behavior too), then
 * non-test preference before the unique-global fallback, else null (the
 * caller skips — god-node guard).
 */
function chooseClassCandidate(
  typeCandidates: LabelIndexEntry[],
  callerFile: string,
  candidateMatchesImport: (candidate: LabelIndexEntry) => boolean,
): LabelIndexEntry | null {
  if (typeCandidates.length === 0) return null;
  const importMatches = typeCandidates.filter(candidateMatchesImport);
  if (importMatches.length === 1) return importMatches[0];
  const preferred = preferNonTest(typeCandidates, callerFile);
  if (preferred.length === 1) return preferred[0];
  return null;
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
      const returnType = doc.properties?.return_type;
      if (
        typeof storedId !== 'string' ||
        !storedId.startsWith(prefix) ||
        typeof sourceFile !== 'string'
      ) {
        return [];
      }
      const node: CodeNode = {
        id: storedId.slice(prefix.length),
        label: String(doc.name ?? ''),
        kind: doc.type as CodeNode['kind'],
        sourceFile,
      };
      // F8: unchanged files' declared return types are reconstructed from
      // their stored `properties.return_type` (only when present).
      if (typeof returnType === 'string' && returnType !== '') {
        node.returnType = returnType;
      }
      return [node];
    });
  } catch {
    dbNodes = []; // best-effort: DB unavailable → fresh nodes only
  }

  const allNodes = [...freshNodes, ...dbNodes];
  const index = buildLabelIndex(allNodes);
  const classIndex = buildClassIndex(allNodes);
  const returnTypeIndex = buildReturnTypeIndex(allNodes);
  // Method node ids actually present (`.name()` entries) — a typed member
  // call only ever targets an EXISTING method node (never invented).
  const methodIds = new Set(
    allNodes.filter((node) => node.kind === 'method').map((node) => node.id),
  );

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

      // F7: a typed member call resolves by the receiver's DECLARED TYPE
      // before the name-based ladder applies — the type is authoritative and
      // the ladder never guesses on its behalf. Type → class candidates:
      // import-bound preference (exactly one candidate in an imported file),
      // else non-test preference, else a globally unique class, else skip.
      if (rawCall.kind === 'method' && rawCall.receiver?.typeName) {
        const typeCandidates = dedupeCandidates(
          classIndex.get(rawCall.receiver.typeName) ?? [],
        );
        const chosen = chooseClassCandidate(
          typeCandidates,
          relPath,
          candidateMatchesImport,
        );
        if (chosen === null) {
          skippedAmbiguous++;
          continue;
        }
        // The method node must EXIST (god-node guard: never invent a method).
        const methodId = makeId(chosen.id, callee);
        if (!methodIds.has(methodId)) {
          skippedAmbiguous++;
          continue;
        }
        const confidence: 'EXTRACTED' | 'INFERRED' =
          rawCall.receiver.typeSource === 'return_flow'
            ? 'INFERRED'
            : 'EXTRACTED';
        pushResolvedEdge(
          extraction,
          rawCall,
          { id: methodId, file: chosen.file },
          confidence,
          relPath,
        );
        resolved++;
        continue;
      }

      // F8: a member call whose receiver is initialized by a call to a
      // function typed ELSEWHERE (`const svc = getService(); svc.start()`)
      // resolves through the global return-type index — ONE propagation hop
      // only. The receiver fact carries the bare initializer callee and no
      // in-file typeName. On SUCCESS the edge is emitted and the ladder is
      // NOT consulted again (no double-emit). On ANY lookup failure (unknown
      // initializer, ambiguous initializer, unknown class, missing method
      // node) the branch FALLS THROUGH to the generic F6 ladder below, which
      // may still resolve the rawCall as a receiver-less-style unique
      // `.name()` lookup (INFERRED) — the ladder's uniqueness requirement is
      // the god-node guard, so falling through can never invent anything.
      if (rawCall.kind === 'method' && rawCall.receiver?.initializerCall) {
        const initializer = rawCall.receiver.initializerCall.trim();
        const seenReturnTypes = new Set<string>();
        const retCandidates = (returnTypeIndex.get(`${initializer}()`) ?? []).filter(
          (entry) => {
            const key = `${entry.typeName}\u0000${entry.file}`;
            if (seenReturnTypes.has(key)) return false;
            seenReturnTypes.add(key);
            return true;
          },
        );
        const returnTypeMatchesImport = (
          candidate: ReturnTypeIndexEntry,
        ): boolean => {
          const fileId = makeId(fileStem(candidate.file));
          for (const imported of importedFileIds) {
            if (fileId === imported) return true;
          }
          return false;
        };
        // 1. initializerCall lookup: import evidence first (unaffected by
        //    test/non-test), else non-test preference before the
        //    unique-global fallback (Graphify disambiguate stage 1). A
        //    failed lookup does NOT skip — the F6 ladder gets its chance.
        let chosen: ReturnTypeIndexEntry | null = null;
        if (retCandidates.length > 0) {
          const importMatches = retCandidates.filter(returnTypeMatchesImport);
          if (importMatches.length === 1) chosen = importMatches[0];
          else {
            const preferred = preferNonTest(retCandidates, relPath);
            if (preferred.length === 1) chosen = preferred[0];
          }
        }
        let f8Resolved = false;
        if (chosen !== null) {
          // 2. Return type → class candidates: EXACTLY the F7 class-name index
          //    path (import-bound preference, non-test preference, else unique
          //    global, else skip). Failure falls through to the F6 ladder.
          const typeCandidates = dedupeCandidates(
            classIndex.get(chosen.typeName) ?? [],
          );
          const chosenClass = chooseClassCandidate(
            typeCandidates,
            relPath,
            candidateMatchesImport,
          );
          if (chosenClass !== null) {
            // 3. The method node must EXIST (god-node guard: never invent).
            //    Missing method → fall through to the F6 ladder.
            const retMethodId = makeId(chosenClass.id, callee);
            if (methodIds.has(retMethodId)) {
              // Return-flow provenance → INFERRED (F7 confidence rule).
              pushResolvedEdge(
                extraction,
                rawCall,
                { id: retMethodId, file: chosenClass.file },
                'INFERRED',
                relPath,
              );
              resolved++;
              f8Resolved = true;
            }
          }
        }
        if (f8Resolved) continue;
        // Fall through: the generic F6 ladder below gets its chance.
      }

      const key = INDEX_KEY_FOR_KIND[rawCall.kind](callee);
      const candidates = dedupeCandidates(index.get(key) ?? []);
      if (candidates.length === 0) {
        danglingDropped++;
        continue;
      }

      // 1. Import evidence: exactly one candidate in an imported file
      //    (EXTRACTED — an explicit import binding wins regardless of
      //    test/non-test, Graphify behavior too).
      const importMatches = candidates.filter(candidateMatchesImport);
      if (importMatches.length === 1) {
        pushResolvedEdge(extraction, rawCall, importMatches[0], 'EXTRACTED', relPath);
        resolved++;
        continue;
      }

      // 2. Non-test preference BEFORE the unique-global check (Graphify
      //    disambiguate stage 1): a NON-test caller drops test-file
      //    candidates, so a label polluted by test mocks/stubs still
      //    resolves when exactly one non-test candidate survives. A test
      //    caller keeps the full set (test-local resolution allowed).
      const preferred = preferNonTest(candidates, relPath);
      if (preferred.length === 1) {
        pushResolvedEdge(extraction, rawCall, preferred[0], 'INFERRED', relPath);
        resolved++;
        continue;
      }
      if (preferred.length === 0) {
        skippedAmbiguous++;
        continue;
      }

      // 3. Member calls stay conservative: no proximity guessing (F7 receiver
      //    typing would be required to disambiguate receivers).
      if (rawCall.kind === 'method') {
        skippedAmbiguous++;
        continue;
      }

      // 4. Path proximity over the preferred candidates: strict unique
      //    winner only (a nearer test mock never wins — already filtered).
      const winner = pathProximityWinner(relPath, preferred);
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
