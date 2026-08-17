# scripts/code-graph.mjs — Katra-native code graph (F5)

Scan a codebase root, classify changes against the persisted manifest, and sync
the structural code graph into `knowledge_nodes` / `knowledge_relationships`.

Usage:

    node scripts/code-graph.mjs <root> [--dry-run] [--force]

- `MONGO_URI` env (default `mongodb://admin:change-me@localhost:27017/katra?authSource=admin`).
- `--dry-run`: print the change classification only (no extraction, no writes).
- `--force`: treat every scanned file as modified and re-extract everything.
- Prerequisite: build output — run `cd server && npm run build` first.

The same capability is available via the MCP tools `scan_codebase` /
`sync_code_graph` / `code_graph_status`.
