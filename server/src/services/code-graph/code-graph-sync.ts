/**
 * Code graph sync (F3) — merges native code-graph extractions into
 * `knowledge_nodes` / `knowledge_relationships` and physically retracts the
 * fragment of any changed/deleted source file before the new fragment is
 * inserted (Graphify `build_merge(prune_sources=...)` semantics, no
 * tombstones). Retraction is guarded by both the `graphify:` id prefix and
 * `properties.code_root`, so legacy graphify-seed documents (which carry no
 * code_root) and fragments owned by other scan roots are never touched. A
 * modified file whose extraction failed is shrink-guarded: its old fragment
 * stays intact and no upsert happens.
 *
 * @see CONTRACT.md §F3, §Goal, §Boundaries
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  Db,
  type AnyBulkWriteOperation,
  type Document,
} from 'mongodb';
import type {
  ChangeSet,
  FileExtraction,
  SyncResult,
} from './types.js';

/** Node ids in the KG keep the `graphify:` prefix (shared with seeded nodes). */
const KG_NODE_PREFIX = 'graphify:';

/** Edge id shape, Graphify-compatible: `graphify:edge:<fromId>:<rel>:<toId>`. */
const KG_EDGE_PREFIX = 'graphify:edge:';

/** Max bulkWrite ops per batch (determinism guard, CONTRACT §F3). */
const BULK_CHUNK_SIZE = 500;

/** Optional collection-name overrides (tests use `test_`-prefixed names). */
export interface CodeGraphSyncCollections {
  nodes: string;
  relationships: string;
  syncLog: string;
  scanState: string;
}

/** Suffix → language tag (mirrors the scanner's LANGUAGES dispatch). */
const LANGUAGE_BY_SUFFIX: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
};

/** Language tag for a relPath, or null for unsupported suffixes. */
function languageFor(relPath: string): string | null {
  const dot = relPath.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGUAGE_BY_SUFFIX[relPath.slice(dot + 1).toLowerCase()] ?? null;
}

/** KG node id for an extraction id (prefix kept for seed-identity sharing). */
function kgNodeId(nodeId: string): string {
  return `${KG_NODE_PREFIX}${nodeId}`;
}

/** KG edge id: `graphify:edge:<storedFromId>:<relation>:<storedToId>`. */
function kgEdgeId(from: string, relation: string, to: string): string {
  return `${KG_EDGE_PREFIX}${kgNodeId(from)}:${relation}:${kgNodeId(to)}`;
}

/** Split ops into batches of ≤ `size` (bulkWrite determinism guard). */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Ops that applied: inserted docs (upsertedCount) plus actually modified
 * docs (modifiedCount). The driver reports inserts as upserted with
 * matched = 0 and modifications as matched + modified, so this sum counts
 * every applied op exactly once; matched-but-unmodified ops wrote nothing.
 */
function countApplied(res: {
  upsertedCount: number;
  modifiedCount: number;
}): number {
  return res.upsertedCount + res.modifiedCount;
}

/** Document id of the scan-state manifest, same shape as manifest-store's. */
function manifestDocumentId(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex');
}

/** Manifest document shape (string `_id`), mirroring manifest-store. */
interface ScanStateManifestDoc {
  _id: string;
  root: string;
  updatedAt: string;
  files: Record<string, unknown>;
}

/**
 * Sync engine for the native code graph. Katra service convention: the
 * MongoDB `Db` is injected by the caller; collection names are overridable
 * for tests.
 */
export class CodeGraphSync {
  private readonly nodesCollection: string;
  private readonly relationshipsCollection: string;
  private readonly syncLogCollection: string;
  private readonly scanStateCollection: string;

  constructor(
    private db: Db,
    collections?: Partial<CodeGraphSyncCollections>,
  ) {
    this.nodesCollection = collections?.nodes ?? 'knowledge_nodes';
    this.relationshipsCollection =
      collections?.relationships ?? 'knowledge_relationships';
    this.syncLogCollection = collections?.syncLog ?? 'code_sync_log';
    this.scanStateCollection = collections?.scanState ?? 'code_scan_state';
  }

  /**
   * Retract the fragments of changed/deleted files, then bulk-upsert the
   * extracted fragments of added/modified files. Deletions are retracted
   * first so the new fragment never coexists with the old one.
   */
  async sync(
    root: string,
    changes: ChangeSet,
    extractions: Map<string, FileExtraction>,
  ): Promise<SyncResult> {
    const resolvedRoot = resolve(root);
    const affected = [
      ...new Set([...changes.modified, ...changes.deleted]),
    ].sort();

    // Shrink guard: a modified file FAILS when its extraction is absent or
    // errored with zero nodes — no retraction, no insert, old fragment intact.
    const failed = new Set<string>();
    for (const relPath of changes.modified) {
      const extraction = extractions.get(relPath);
      if (
        !extraction ||
        (extraction.errors.length > 0 && extraction.nodes.length === 0)
      ) {
        failed.add(relPath);
      }
    }

    const retractPaths = affected.filter((p) => !failed.has(p));
    const upsertPaths = [...new Set([...changes.added, ...changes.modified])]
      .filter((p) => !failed.has(p))
      .filter((p) => (extractions.get(p)?.nodes.length ?? 0) > 0)
      .sort();

    const result: SyncResult = {
      root: resolvedRoot,
      scanned: changes.total,
      added: changes.added.length,
      modified: changes.modified.length,
      deleted: changes.deleted.length,
      unchanged: changes.unchanged.length,
      extracted: upsertPaths.length,
      failed: [...failed].sort(),
      nodesUpserted: 0,
      edgesUpserted: 0,
      nodesRetracted: 0,
      edgesRetracted: 0,
    };

    // Physical retraction before insert. The `graphify:` id prefix plus the
    // code_root match keeps legacy seed documents (no code_root) and other
    // roots' fragments out of reach.
    if (retractPaths.length > 0) {
      const nodesDeleted = await this.db
        .collection(this.nodesCollection)
        .deleteMany({
          id: { $regex: '^graphify:' },
          'properties.code_root': resolvedRoot,
          'properties.source_file': { $in: retractPaths },
        });
      const edgesDeleted = await this.db
        .collection(this.relationshipsCollection)
        .deleteMany({
          id: { $regex: '^graphify:edge:' },
          'properties.code_root': resolvedRoot,
          'properties.source_file': { $in: retractPaths },
        });
      result.nodesRetracted = nodesDeleted.deletedCount;
      result.edgesRetracted = edgesDeleted.deletedCount;
    }

    // Bulk upsert of the new fragments (ordered:false, chunked ≤ 500 ops).
    const nodeOps: AnyBulkWriteOperation<Document>[] = [];
    const edgeOps: AnyBulkWriteOperation<Document>[] = [];
    const now = new Date();

    for (const relPath of upsertPaths) {
      const extraction = extractions.get(relPath)!;
      for (const node of extraction.nodes) {
        const id = kgNodeId(node.id);
        nodeOps.push({
          updateOne: {
            filter: { id },
            update: {
              $set: {
                type: node.kind,
                name: node.label,
                properties: {
                  name: node.label,
                  source_path: relPath,
                  source_file: relPath,
                  code_language: languageFor(relPath),
                  summary: `Katra-code ${node.kind}: ${node.label}`,
                  code_root: resolvedRoot,
                },
                source: 'katra-code',
                updated_at: now,
              },
              $setOnInsert: {
                id,
                user_id: 'kolega-agent',
                created_at: now,
              },
            },
            upsert: true,
          },
        });
      }
      for (const edge of extraction.edges) {
        const fromId = kgNodeId(edge.from);
        const toId = kgNodeId(edge.to);
        const edgeId = `${KG_EDGE_PREFIX}${fromId}:${edge.relation}:${toId}`;
        edgeOps.push({
          updateOne: {
            filter: { id: edgeId },
            update: {
              $set: {
                relationship_type: edge.relation,
                from_id: fromId,
                to_id: toId,
                strength: edge.weight,
                properties: {
                  weight: edge.weight,
                  source_file: relPath,
                  code_root: resolvedRoot,
                },
                source: 'katra-code',
                updated_at: now,
              },
              $setOnInsert: {
                id: edgeId,
                user_id: 'kolega-agent',
                created_at: now,
              },
            },
            upsert: true,
          },
        });
      }
    }

    for (const chunk of chunked(nodeOps, BULK_CHUNK_SIZE)) {
      const res = await this.db
        .collection(this.nodesCollection)
        .bulkWrite(chunk, { ordered: false });
      result.nodesUpserted += countApplied(res);
    }
    for (const chunk of chunked(edgeOps, BULK_CHUNK_SIZE)) {
      const res = await this.db
        .collection(this.relationshipsCollection)
        .bulkWrite(chunk, { ordered: false });
      result.edgesUpserted += countApplied(res);
    }

    return result;
  }

  /**
   * Counts of `graphify:`-prefixed nodes/edges owned by `root`, plus the
   * lastSyncAt timestamp read straight from the `code_scan_state` manifest
   * document (same shape as manifest-store writes; no import to avoid
   * coupling).
   */
  async status(root: string): Promise<{
    nodeCount: number;
    edgeCount: number;
    lastSyncAt: string | null;
  }> {
    const resolvedRoot = resolve(root);
    const [nodeCount, edgeCount, manifest] = await Promise.all([
      this.db.collection(this.nodesCollection).countDocuments({
        id: { $regex: '^graphify:' },
        'properties.code_root': resolvedRoot,
      }),
      this.db.collection(this.relationshipsCollection).countDocuments({
        id: { $regex: '^graphify:edge:' },
        'properties.code_root': resolvedRoot,
      }),
      this.db
        .collection<ScanStateManifestDoc>(this.scanStateCollection)
        .findOne({ _id: manifestDocumentId(resolvedRoot) }),
    ]);
    return {
      nodeCount,
      edgeCount,
      lastSyncAt: (manifest?.updatedAt as string | undefined) ?? null,
    };
  }

  /** Append one audit document per sync to `code_sync_log`. */
  async recordSync(result: SyncResult): Promise<void> {
    await this.db.collection(this.syncLogCollection).insertOne({
      ...result,
      root: resolve(result.root),
      at: new Date(),
    });
  }
}

/** CONTRACT §F3 interface: sync via a fresh CodeGraphSync on the injected db. */
export async function syncCodeGraph(
  db: Db,
  root: string,
  changes: ChangeSet,
  extractions: Map<string, FileExtraction>,
): Promise<SyncResult> {
  return new CodeGraphSync(db).sync(root, changes, extractions);
}
