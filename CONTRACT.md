# CONTRACT — Katra-Native Code Graph (loop-director)

Branch: `test/feat-native-code-graph` · Author: Loop Director · Date: 2026-08-17

## Goal

Give Katra its own codebase structural mapping: scan, parse, merge into the knowledge
graph, and retract on change — so Katra no longer requires Graphify to initially map a
codebase or to expand its view as the codebase evolves. The methodology is a faithful
Node/TypeScript reimplementation of Graphify's pipeline (detect → extract → build-merge
→ retract), validated against the Graphify 0.9.6 source installed on this machine.

## Methodology reference (from Graphify investigation, 2026-08-17)

- **File collection**: recursive walk, hard-skip noise dirs (`node_modules`, `.git`, `venv`,
  `dist`, `build`, `target`, `.next`, `__pycache__`, `graphify-out`, `.graphify`, `*.egg-info`),
  `.gitignore`-style last-match-wins ignore with `!` negation and parent exclusion,
  overlay `.katraignore` (Graphify's `.graphifyignore` equivalent), suffix dispatch,
  reject symlinks resolving outside root, no global size cap.
- **Change detection**: persisted manifest `{relpath: {mtimeMs, size, hash}}`; per scan a file
  is added (missing key), unchanged (mtime equal — fast path), modified (mtime differs and
  hash differs), or deleted (manifest key absent from live scan). Renames are delete + add.
  Hash = SHA-256 (Graphify uses MD5; SHA-256 is strictly stronger and has no compat need).
- **Deletion**: physical retraction, never tombstones. Nodes/edges whose source file is in
  the deleted/changed set are removed before the new fragment is inserted
  (Graphify `build_merge(prune_sources=...)` semantics).
- **Shrink guard**: if extraction of a changed file FAILS, its previous nodes/edges are kept
  (Graphify refuses to overwrite with fewer nodes unless deletions are explicit).
- **Redundancy**: Graphify's MinHash/LSH fuzzy merge (3-gram shingles, 128 perms, LSH bands,
  Jaro-Winkler ≥ 92) is documented in the research notes but is OUT OF SCOPE for this loop —
  deterministic ID-based upsert already prevents structural duplicates; fuzzy entity merging
  is a future feature.
- **IDs (Graphify-compatible)**: `makeId(parts)` = NFKC → non-word runs → `_` → collapse `_` →
  strip edges → casefold. File node = `makeId(stem)` where stem = repo-relative posix path
  minus extension. Symbols = `fileId + '_' + name`.
- **Multi-repo namespacing (AMENDED 2026-08-17, F3 verifier finding)**: Katra's knowledge graph is
  global across codebases, and repo-relative stems collide across roots (RankPilot and Katra both
  have `server/src/...`). Graphify solves exactly this in its global graph via `repo_tag::`
  prefixes (`prefix_graph_for_global`). Native sync therefore stores node IDs as
  `graphify:<rootKey>:<stem>` and edge IDs as `graphify:edge:<rootKey>:<fromId>:<relation>:<toId>`
  where `rootKey = sha256(resolve(root)).slice(0, 12)` and fromId/toId are the stored (root-scoped)
  node IDs. Cross-root upserts can no longer collide; retraction safety holds by construction.
  Legacy Graphify-seed nodes (`graphify:<stem>`, no rootKey, source `graphify-seed`) are NEVER
  touched by native sync — for a repo previously seeded by Graphify, the Loop Director retires the
  legacy seed fragment explicitly (one-time, logged, after a successful native sync).
- **Confidence**: `EXTRACTED` (weight 1.0) for tree-sitter facts; `INFERRED` (weight 0.8)
  reserved for future cross-file resolution. Unresolved externals produce NO node (never
  invent a definition).

## Boundaries (what must NOT be touched)

- No changes to existing memory services (`semantic-memory-service`, compaction pipeline,
  embedding, LLM curation) — the code graph writes directly to `knowledge_nodes` /
  `knowledge_relationships`, exactly like `scripts/compact-graphify-to-kg.mjs` does today.
- No schema changes to `knowledge_nodes` / `knowledge_relationships`. Use the existing
  field shape: `{id, type, name, properties, source, user_id, created_at, updated_at}` and
  `{id, relationship_type, from_id, to_id, strength, properties, source, user_id, created_at, updated_at}`.
- Do NOT delete or modify `scripts/compact-graphify-to-kg.mjs`, `scripts/ingest-graphify-seed.mjs`
  (Graphify interop stays; F5 adds a sibling, not a replacement).
- Do NOT touch `mcp-server.ts` outside the three new tool registrations/handlers/dispatch
  cases (F4 only), and do not reorder or rename existing tools.
- Do NOT change esbuild config, tsconfig, or the Dockerfile in this loop (WASM grammars are
  runtime npm deps — the image already runs `npm install --production`).
- Retraction must never touch nodes whose `id` does not start with `graphify:` and whose
  `properties.source_file` is not in the explicit changed/deleted set. Never delete
  `graphify:`-prefixed nodes that belong to OTHER scan roots (match `properties.source_file`
  against this root's relative paths only).
- No fuzzy dedup, no community detection, no HTML/report exports (future features).

## Success criteria (testable)

1. `cd server && npm run test:unit` passes, including the new code-graph suites.
2. Full suite (`npm test`) stays green at ≥ its current pass count (no regressions).
3. A scan of a fixture tree classifies added/modified/unchanged/deleted correctly across
   two consecutive scans (mtime + hash paths both covered).
4. Extraction of TS/TSX/JS/Python fixture files yields file/class/function/method nodes and
   contains/method/imports/imports_from/calls edges with the exact ID scheme above.
5. Sync into a test-prefixed Mongo collection: re-syncing a modified file replaces its
   nodes/edges (no accumulation); deleting a file retracts its nodes/edges; a failed
   extraction leaves the old fragment intact (shrink guard).
6. MCP: `scan_codebase` returns change classification without writes; `sync_code_graph`
   returns counts (extracted/upserted/retracted/failed) and persists the manifest;
   `code_graph_status` reports node/edge counts and last sync time.
7. `node scripts/code-graph.mjs <root> --dry-run` prints the change classification.

## Interfaces

### Shared types — `server/src/services/code-graph/types.ts` (F1 owns; later features only import)

```ts
export interface FileState { mtimeMs: number; size: number; hash: string; }
export interface ScanManifest { root: string; updatedAt: string; files: Record<string, FileState>; }
export interface ScannedFile { relPath: string; absPath: string; size: number; mtimeMs: number; hash: string; language: string; }
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'unchanged';
export interface FileChange { relPath: string; kind: ChangeKind; hash?: string; }
export interface ChangeSet { added: string[]; modified: string[]; deleted: string[]; unchanged: string[]; total: number; }
export type CodeNodeKind = 'file' | 'class' | 'function' | 'method' | 'variable';
export interface CodeNode { id: string; label: string; kind: CodeNodeKind; sourceFile: string; sourceLocation?: string; }
export type CodeRelation = 'contains' | 'method' | 'imports' | 'imports_from' | 'calls' | 'references' | 'inherits';
export interface CodeEdge { from: string; to: string; relation: CodeRelation; confidence: 'EXTRACTED' | 'INFERRED'; weight: number; sourceFile: string; sourceLocation?: string; }
export interface FileExtraction { nodes: CodeNode[]; edges: CodeEdge[]; errors: string[]; }
export interface SyncResult {
  root: string; scanned: number; added: number; modified: number; deleted: number; unchanged: number;
  extracted: number; failed: string[]; nodesUpserted: number; edgesUpserted: number;
  nodesRetracted: number; edgesRetracted: number;
}
```

### F1 — `codebase-scanner.ts` + `manifest-store.ts` (files F1 exclusively owns)

```
server/src/services/code-graph/types.ts
server/src/services/code-graph/codebase-scanner.ts
server/src/services/code-graph/manifest-store.ts
server/tests/unit/code-graph/scanner.test.ts
server/tests/unit/code-graph/manifest-store.test.ts
```

- `scanCodebase(root: string, opts?: { followSymlinks?: boolean }): Promise<ScannedFile[]>`
  — walk; dispatch on supported suffixes (ts, tsx, js, mjs, cjs, mts, cts, py, json, md, sh);
  noise-dir hard skip; `.gitignore` + `.katraignore` last-match-wins with negation and parent
  exclusion; symlink targets outside root rejected (realpath containment); deterministic sort
  by relPath. sha256 content hash, posix relPaths.
- `classifyChanges(prev: ScanManifest | null, current: ScannedFile[]): ChangeSet`
- `manifest-store.ts`: `loadManifest(db, root)`, `saveManifest(db, root, files)` — collection
  `code_scan_state`, document `{_id: sha256(normalizedRoot), root, updatedAt, files}`.
  Both take a `mongodb.Db` as constructor/dependency (Katra service convention).
- Tests use `tests/helpers/db.ts` + `test_` collection prefix, cleanup in `afterAll`.

### F2 — `codebase-extractor.ts` + `grammars.ts` (files F2 exclusively owns)

```
server/src/services/code-graph/codebase-extractor.ts
server/src/services/code-graph/grammars.ts
server/tests/unit/code-graph/extractor.test.ts
server/tests/fixtures/code-graph/* (fixture source files)
server/package.json (adds runtime deps: web-tree-sitter, tree-sitter-javascript, tree-sitter-typescript, tree-sitter-python)
```

- `extractFile(root: string, relPath: string, source: string | Buffer): Promise<FileExtraction>`
  — LanguageConfig-driven tree-sitter walk (web-tree-sitter + WASM grammars loaded via
  `createRequire(import.meta.url).resolve('<pkg>/<pkg>.wasm')`; `Parser.init()` once).
  TS/TSX/JS/MTS/CTS/JSX via typescript+tsx / javascript grammars; PY via python grammar.
  Node/edge emission per Graphify: file node (sourceLocation 'L1'), class/interface nodes
  (`contains`), function nodes labeled `name()` (`contains`), methods labeled `.name()`
  (`method`), imports (`imports` to resolved relative file ID or `imports_from`), same-file
  calls (`calls`, EXTRACTED 1.0, resolved via per-file label index; unresolved calls are
  dropped — never a stub node). JSON/MD/SH: file node only (regex fallback). Unknown suffix:
  return `{nodes: [], edges: [], errors: []}`. Deterministic ID scheme as in §Goal.
- Must never throw on parse failure — return `errors: [message]` and whatever nodes were
  extracted so far (shrink-guard contract).
- Unit tests assert exact node IDs, labels, relations, and weights on fixture files.

### F3 — `code-graph-sync.ts` (files F3 exclusively owns)

```
server/src/services/code-graph/code-graph-sync.ts
server/tests/unit/code-graph/sync.test.ts
server/tests/integration/code-graph/sync.integration.test.ts
```

- `syncCodeGraph(db, root, changes: ChangeSet, extractions: Map<string, FileExtraction>): Promise<SyncResult>`
  — for each relPath in modified ∪ deleted: retract (deleteMany) `knowledge_nodes` with
  `id: /^graphify:/` and `properties.code_root === resolvedRoot` and
  `properties.source_file === relPath`, and `knowledge_relationships` whose `id: /^graphify:edge:/`
  and `properties.code_root === resolvedRoot` and `properties.source_file === relPath`. Then bulk
  upsert nodes (shape: `type = kind`, `name = label`, `properties: {name, source_path: relPath,
  code_language, summary, source_file: relPath, code_root}`) and edges (`relationship_type =
  relation`, `strength = weight`, `properties: {weight, source_file, code_root}`) with
  `source: 'katra-code'`, `user_id: 'kolega-agent'`. Stored IDs are root-scoped per the AMENDED
  ID scheme: node `id = graphify:<rootKey>:<node.id>`, edge
  `id = graphify:edge:<rootKey>:<fromId>:<relation>:<toId>` (fromId/toId = stored node IDs).
  Skip retraction for any modified file whose extraction is absent from the map (shrink guard).
- Integration test uses test-prefixed collections and verifies retraction/replacement
  end-to-end against local Mongo.

### F4 — MCP tools (files F4 exclusively owns)

```
server/src/services/code-graph/tool-schemas.ts (zod inputs)
server/src/mcp-server.ts (three tool entries + handlers + dispatch cases)
server/tests/unit/code-graph/mcp-tools.test.ts
```

- Tools: `scan_codebase {root, followSymlinks?}` (classify vs stored manifest, NO graph
  writes), `sync_code_graph {root}` (scan → extract changed → syncCodeGraph → saveManifest),
  `code_graph_status {root}` (counts of `graphify:`-prefixed nodes/edges + last scan time
  + pending changes). Handlers return `TextContent[]` per existing convention; dispatch via
  the existing switch. Follow the `handleXxx` naming/pattern exactly.

### F5 — CLI script (files F5 exclusively owns)

```
scripts/code-graph.mjs
scripts/README-code-graph.md (usage, 20 lines max)
```

- `node scripts/code-graph.mjs <root> [--dry-run] [--force]`: connects to Mongo
  (`MONGO_URI` env, default `mongodb://admin:change-me@localhost:27017/katra?authSource=admin`),
  imports the built modules from `../server/build/services/code-graph/*.js` (esbuild emits
  per-file output, so these exist after `cd server && npm run build`), prints the change
  classification, and — unless `--dry-run` — extracts and syncs. Exit code 0 on success,
  1 on error. `--force` re-extracts all files even when unchanged.
- Does NOT modify the two graphify scripts. Dogfood run (by the Loop Director, not the
  Generator): `node scripts/code-graph.mjs /home/johnpellew/Katra-Agentic-Memory`.

## F6 — Cross-file call resolution (loop-director, 2026-08-17)

### Goal

Resolve call edges across files: `caller()` in `a.ts` calling `target()` defined in `b.ts`
becomes a `calls` edge between the two node IDs, with honest confidence marking
(`EXTRACTED` 1.0 when backed by import evidence, `INFERRED` 0.8 otherwise). Ambiguous calls
are SKIPPED — the graph never guesses.

### Reference (Graphify 0.9.6 semantics — read these files before implementing)

- `graphify/symbol_resolution.py`: `resolve_cross_file_raw_calls` (~L288), `build_label_index`
  (~L59), `node_is_resolvable_symbol` (~L37), `normalise_callable_label` (~L31)
- `graphify/paths.py`: `disambiguate_ambiguous_candidates` (~L153), `_path_proximity_winner`
  (~L95), `_is_test_path` (~L60)
- Installed at `/home/johnpellew/.local/share/uv/tools/graphifyy/lib/python3.12/site-packages/graphify/`

### Interfaces

```ts
// types.ts — additions
export interface RawCall {
  caller: string;          // node id of the calling function/method (file id when top-level)
  callee: string;          // bare callee name (no (), no .)
  kind: 'function' | 'method' | 'constructor';
  sourceLocation?: string; // L{n} of the call site
}
// FileExtraction gains: rawCalls?: RawCall[]
```

- `cross-file-resolver.ts` exports:
  - `buildLabelIndex(nodes: CodeNode[]): Map<string, { id: string; file: string }[]>` —
    function labels `name()`, method labels `.name()`, class names (for constructors).
  - `resolveCrossFileCalls(db: Db, root: string, extractions: Map<string, FileExtraction>):
    Promise<{ resolved: number; skippedAmbiguous: number; danglingDropped: number }>` —
    (1) builds the global index from the fresh extractions PLUS existing `knowledge_nodes`
    with `source:'katra-code'` and `properties.code_root === resolvedRoot` whose
    `properties.source_file` is NOT being replaced by this sync (DB nodes stand in for
    unchanged files); (2) for every rawCall in every extraction, in deterministic order
    (files sorted, rawCalls in emission order), resolves per the algorithm below and
    appends `calls` edges to the caller's extraction; (3) drops rawCalls whose resolved
    target is not in the final node set (dangling).
- Resolution algorithm (in order of evidence):
  1. Candidate list from index; empty → skip (danglingDropped if target node absent).
  2. Import evidence: if the caller's file has `imports_from` edges to file node F and
     exactly one candidate lives in F → `calls`, EXTRACTED, 1.0.
  3. Unique global candidate → `calls`, INFERRED, 0.8.
  4. Multiple candidates → path proximity tiebreak (same dir, else longest common path
     prefix with the caller's file; resolve only if a STRICT unique winner) → INFERRED 0.8.
  5. Otherwise skip (skippedAmbiguous) — god-node guard; never connect `log()`/`count()`
     to a random candidate. Method calls (kind 'method') resolve only via uniqueness or
     import evidence; receiver typing is F7.
- Extractor: unresolved in-file calls are now EMITTED as rawCalls (was: dropped). In-file
  resolution behavior and all existing edges unchanged.
- Sync: after node retraction, also delete `knowledge_relationships` whose `to_id` or
  `from_id` is a retracted node id (dangling-edge cleanup so deleting a file removes edges
  INTO it from callers in other files).
- Orchestrators (`mcp-server.ts` sync handler, `scripts/code-graph.mjs`): call
  `resolveCrossFileCalls(db, root, extractions)` after extraction, before `syncCodeGraph`.

### Files F6 owns

```
server/src/services/code-graph/cross-file-resolver.ts        (NEW)
server/src/services/code-graph/codebase-extractor.ts         (MODIFIED — rawCalls)
server/src/services/code-graph/types.ts                      (MODIFIED — RawCall, rawCalls)
server/src/services/code-graph/code-graph-sync.ts            (MODIFIED — dangling-edge cleanup)
server/src/mcp-server.ts                                     (MODIFIED — resolver call in sync handler)
scripts/code-graph.mjs                                       (MODIFIED — resolver call)
server/tests/unit/code-graph/extractor.test.ts               (MODIFIED — rawCalls assertions)
server/tests/unit/code-graph/cross-file-resolver.test.ts     (NEW)
server/tests/integration/code-graph/sync.integration.test.ts (MODIFIED — dangling-edge test)
server/tests/fixtures/code-graph/cross-*.ts                  (NEW fixtures)
```

### Success criteria

1. `npm run test:unit` fully green (existing suites unchanged in behavior; extractor edges
   byte-identical to today).
2. New unit tests cover: unique → INFERRED 0.8; import-evidence → EXTRACTED 1.0; ambiguous
   skip; path-proximity strict-winner; member-call conservative skip; constructor `new X()`
   → class node; rawCalls emitted with caller/callee/sourceLocation.
3. Integration: A calls B cross-file → edge appears; delete B → sync retracts B's nodes AND
   the A→B edge (no dangling).
4. Live dogfood: forced re-sync of the Katra repo raises `calls` from ~1,132 to ≥1,800,
   zero dangling edges (`to_id`/`from_id` not in node set).

### Boundaries

- Do NOT change `syncCodeGraph`'s upsert/retraction predicates beyond the dangling-edge
  cleanup described above; do NOT change scanner/manifest/status/CLI flag behavior.
- Do NOT touch `scripts/backfill-embeddings.mjs`, the Graphify interop scripts, or auth.
- Resolver must never invent nodes; INFERRED weight stays 1.0 with confidence INFERRED
  (existing edges carry weight 1.0; confidence distinguishes provenance).

## Known limitations (explicit, not defects)

- Cross-file call resolution, fuzzy entity dedup (MinHash/LSH), community detection, and
  watch mode are future features. Same-file calls + file-level import edges are the v1 map.
- Renames are delete+add (no identity preservation) — matches Graphify.
- RESOLVED 2026-08-17: TS-style specifier resolution — `./x.js` now probes `x.ts`/`x.tsx`/…
  and index variants (Graphify `_resolve_js_import_path` semantics).

## Verification loop rules

- Generator implements + writes tests; Verifier (independent) runs
  `cd server && npm run test:unit` and `npm test`, grades against this CONTRACT, checks for
  boundary violations and poison, reports PASS/FAIL with evidence. Max 3 refinement attempts,
  then full revert to last green state.
- No merge to `main` without explicit human APPROVE after the Docker gate.
