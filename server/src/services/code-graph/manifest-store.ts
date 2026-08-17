/**
 * Manifest store (F1) — persists scan manifests to MongoDB so consecutive
 * scans can classify changes. Collection `code_scan_state`, one document per
 * scan root, keyed by the SHA-256 of the resolved root path.
 */

import { Db, type Collection } from 'mongodb';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { FileState, ScanManifest } from './types.js';

interface StoredManifest {
  _id: string;
  root: string;
  updatedAt: string;
  files: Record<string, FileState>;
}

/** Katra service convention: the MongoDB `Db` is injected by the caller. */
export class ManifestStore {
  private db: Db;
  private collectionName: string;

  constructor(db: Db, collectionName: string = 'code_scan_state') {
    this.db = db;
    this.collectionName = collectionName;
  }

  /** Deterministic document id: sha256 hex of the resolved root path. */
  private documentId(root: string): string {
    return createHash('sha256').update(resolve(root)).digest('hex');
  }

  /** The manifests collection, typed to this store's document shape. */
  private collection(): Collection<StoredManifest> {
    return this.db.collection<StoredManifest>(this.collectionName);
  }

  /**
   * Load the persisted manifest for `root`, or null when nothing was saved.
   */
  async loadManifest(root: string): Promise<ScanManifest | null> {
    const doc = await this.collection().findOne({ _id: this.documentId(root) });
    if (!doc) return null;
    return { root: doc.root, updatedAt: doc.updatedAt, files: doc.files ?? {} };
  }

  /**
   * Persist (upsert) the manifest for `root`, replacing any prior document.
   */
  async saveManifest(
    root: string,
    files: Record<string, FileState>,
  ): Promise<void> {
    const id = this.documentId(root);
    const doc: Omit<StoredManifest, '_id'> = {
      root: resolve(root),
      updatedAt: new Date().toISOString(),
      files,
    };
    await this.collection().replaceOne({ _id: id }, doc, { upsert: true });
  }
}
