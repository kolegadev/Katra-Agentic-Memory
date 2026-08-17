#!/usr/bin/env node
/**
 * F5 — Katra-native code graph CLI (CONTRACT.md §F5).
 *
 * Scans a codebase root, classifies changes against the persisted scan
 * manifest, and — unless --dry-run — extracts the changed files and syncs the
 * structural code graph into `knowledge_nodes` / `knowledge_relationships`.
 *
 * Usage: node scripts/code-graph.mjs <root> [--dry-run] [--force]
 */

import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(SCRIPT_DIR, '..', 'server', 'build', 'services', 'code-graph');
const SERVER_PACKAGE_JSON = path.join(SCRIPT_DIR, '..', 'server', 'package.json');

const DEFAULT_MONGO_URI =
  'mongodb://admin:change-me@localhost:27017/katra?authSource=admin';
const MAX_LISTED = 50;

function usage() {
  return [
    'Usage: node scripts/code-graph.mjs <root> [--dry-run] [--force]',
    '',
    'Scans <root>, classifies changes against the persisted manifest, and syncs',
    'the extracted code graph into knowledge_nodes / knowledge_relationships.',
    '',
    '  --dry-run  print the classification only (no extraction, no writes)',
    '  --force    treat every scanned file as modified (re-extract everything)',
    '',
    `Env: MONGO_URI (default ${DEFAULT_MONGO_URI})`,
  ].join('\n');
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--force') {
      flags.add(arg.slice(2));
    } else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}\n`);
      console.error(usage());
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    console.error(
      positional.length === 0
        ? 'Missing <root> argument.\n'
        : 'Expected exactly one <root> argument.\n',
    );
    console.error(usage());
    process.exit(1);
  }
  return {
    root: positional[0],
    dryRun: flags.has('dry-run'),
    force: flags.has('force'),
  };
}

/** Fail fast with a clear message when the esbuild output was not built. */
async function ensureBuildOutput() {
  try {
    await fs.access(path.join(BUILD_DIR, 'codebase-scanner.js'));
  } catch {
    console.error('build output missing — run: cd server && npm run build');
    process.exit(1);
  }
}

/** Load the esbuild-built F1–F3 modules (per-file ESM output). */
async function loadModules() {
  const [scanner, extractor, sync, manifestStore, resolver] = await Promise.all([
    import(pathToFileURL(path.join(BUILD_DIR, 'codebase-scanner.js')).href),
    import(pathToFileURL(path.join(BUILD_DIR, 'codebase-extractor.js')).href),
    import(pathToFileURL(path.join(BUILD_DIR, 'code-graph-sync.js')).href),
    import(pathToFileURL(path.join(BUILD_DIR, 'manifest-store.js')).href),
    import(pathToFileURL(path.join(BUILD_DIR, 'cross-file-resolver.js')).href),
  ]);
  return {
    ...scanner,
    ...extractor,
    ...sync,
    ...manifestStore,
    ...resolver,
  };
}

function printClassification(root, changes, force) {
  console.log(`Code graph classification for ${path.resolve(root)}`);
  console.log(`  total:     ${changes.total}`);
  console.log(`  added:     ${changes.added.length}`);
  console.log(`  modified:  ${changes.modified.length}`);
  console.log(`  deleted:   ${changes.deleted.length}`);
  console.log(`  unchanged: ${changes.unchanged.length}`);
  if (force) {
    console.log('  mode:      forced-full (all scanned files treated as modified)');
  }
  printPaths('added', changes.added);
  printPaths('deleted', changes.deleted);
}

function printPaths(label, relPaths) {
  if (relPaths.length === 0) {
    console.log(`  ${label} files: (none)`);
    return;
  }
  console.log(`  ${label} files:`);
  for (const relPath of relPaths.slice(0, MAX_LISTED)) {
    console.log(`    ${relPath}`);
  }
  const remaining = relPaths.length - MAX_LISTED;
  if (remaining > 0) {
    console.log(`    ... and ${remaining} more`);
  }
}

function printSyncSummary(result) {
  console.log('\nSync complete:');
  console.log(`  scanned:          ${result.scanned}`);
  console.log(`  extracted:        ${result.extracted}`);
  console.log(`  failed:           ${result.failed.length}`);
  for (const relPath of result.failed) {
    console.log(`    ${relPath}`);
  }
  console.log(`  nodes upserted:   ${result.nodesUpserted}`);
  console.log(`  edges upserted:   ${result.edgesUpserted}`);
  console.log(`  nodes retracted:  ${result.nodesRetracted}`);
  console.log(`  edges retracted:  ${result.edgesRetracted}`);
}

function manifestFiles(scan) {
  const files = {};
  for (const f of scan) {
    files[f.relPath] = { mtimeMs: f.mtimeMs, size: f.size, hash: f.hash };
  }
  return files;
}

async function main() {
  const { root, dryRun, force } = parseArgs(process.argv.slice(2));
  await ensureBuildOutput();
  const {
    scanCodebase,
    classifyChanges,
    extractFile,
    CodeGraphSync,
    ManifestStore,
    resolveCrossFileCalls,
  } = await loadModules();

  // The mongodb driver lives under server/node_modules; anchor resolution at
  // server/package.json (mongodb v6 is CJS, so the built ESM modules share
  // this same driver instance).
  const requireFromServer = createRequire(SERVER_PACKAGE_JSON);
  const { MongoClient } = requireFromServer('mongodb');

  const client = new MongoClient(process.env.MONGO_URI || DEFAULT_MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db();

    const store = new ManifestStore(db);
    const prev = await store.loadManifest(root);
    const scan = await scanCodebase(root);
    let changes = classifyChanges(prev, scan);
    if (force) {
      const live = new Set(scan.map((f) => f.relPath));
      changes = {
        added: [],
        modified: scan.map((f) => f.relPath),
        deleted: prev ? Object.keys(prev.files).filter((p) => !live.has(p)) : [],
        unchanged: [],
        total: scan.length,
      };
    }

    printClassification(root, changes, force);

    if (dryRun) {
      await client.close();
      return;
    }

    const byRelPath = new Map(scan.map((f) => [f.relPath, f]));
    const extractions = new Map();
    const failures = [];
    for (const relPath of [...changes.added, ...changes.modified]) {
      try {
        const source = await fs.readFile(byRelPath.get(relPath).absPath, 'utf8');
        extractions.set(relPath, await extractFile(root, relPath, source));
      } catch (err) {
        failures.push(`${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      console.error(`\nExtraction failed for ${failures.length} file(s):`);
      for (const failure of failures) {
        console.error(`  ${failure}`);
      }
    }

    const crossFile = await resolveCrossFileCalls(db, root, extractions);
    console.log(
      `\nCross-file calls: ${crossFile.resolved} resolved, ${crossFile.skippedAmbiguous} ambiguous skipped, ${crossFile.danglingDropped} dangling dropped`,
    );

    const sync = new CodeGraphSync(db);
    const result = await sync.sync(root, changes, extractions);
    await store.saveManifest(root, manifestFiles(scan));
    await sync.recordSync(result);

    printSyncSummary(result);
    await client.close();
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(`code-graph: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
