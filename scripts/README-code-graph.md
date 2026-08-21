# scripts/code-graph.mjs — Katra-native code graph (Satori Graph, F5)

Scan a codebase root, classify changes against the persisted manifest, and
sync the structural code graph into `knowledge_nodes` /
`knowledge_relationships`. This Katra-native graph is the **Satori Graph** —
it replaces the old Graphify toolchain (see "Legacy Graphify migration"
below). The same capability is exposed to agents through three MCP tools:
`scan_codebase`, `sync_code_graph`, and `code_graph_status`.

## CLI

Usage:

    node scripts/code-graph.mjs <root> [--dry-run] [--force]

- `MONGO_URI` env (default `mongodb://admin:change-me@localhost:27017/katra?authSource=admin`).
- `--dry-run`: print the change classification only (no extraction, no writes).
- `--force`: treat every scanned file as modified and re-extract everything.
- Prerequisite: build output — run `cd server && npm run build` first.

## Sync flow

The script loads the esbuild-built modules under
`server/build/services/code-graph/` and runs:

1. **Scan** — `codebase-scanner.ts` walks `<root>` (respecting
   `.gitignore`/`.katraignore` rules) and hashes each file.
2. **Classify** — the scan is compared against the persisted manifest
   (`manifest-store.ts`): added / modified / deleted / unchanged.
3. **Extract** — `codebase-extractor.ts` parses changed files (tree-sitter)
   into structural nodes and edges (files, symbols, imports, calls).
4. **Resolve** — `cross-file-resolver.ts` resolves cross-file references
   against the graph already in the database (resolved / ambiguous-skipped /
   dangling-dropped).
5. **Sync** — `code-graph-sync.ts` upserts nodes and edges into
   `knowledge_nodes` / `knowledge_relationships` and retracts deleted
   files; the manifest is saved and the sync recorded.

## MCP tools

| Tool | What it does |
|------|--------------|
| `scan_codebase` | Scan a local codebase directory (file discovery with `.gitignore`/`.katraignore` rules) and report what changed vs the last scan (added/modified/deleted/unchanged). Does NOT write to the knowledge graph. Use before `sync_code_graph` to preview changes, or to expand Katra's view of a codebase it is working on. |
| `sync_code_graph` | Scan a codebase, extract structure (classes, functions, methods, imports, calls) with tree-sitter, and merge it into the Katra knowledge graph. Deleted files are retracted. Returns counts of nodes/edges upserted and retracted. |
| `code_graph_status` | Report the current state of a codebase in the Katra knowledge graph: node/edge counts and last sync time for the given root. |

## Legacy Graphify migration

The Satori Graph replaces the old Graphify toolchain (previously used by the
bug-fix and loop-director skills). Two one-way migration scripts remain for
historical Graphify data and are not part of the current sync flow:

- `scripts/ingest-graphify-seed.mjs` — reads a Graphify `graph.json` export
  and stores its nodes/edges as `graphify-seed` semantic facts via MCP.
- `scripts/compact-graphify-to-kg.mjs` — compacts `graphify-seed` semantic
  facts directly into `knowledge_nodes` / `knowledge_relationships`,
  bypassing the episodic backlog.

Use these only to bring over data from a pre-Satori-Graph Graphify export;
ongoing code-graph work goes through the MCP tools or `code-graph.mjs`.
