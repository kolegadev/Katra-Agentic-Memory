/**
 * Embedding Service — Semantic vector encoding for memory retrieval
 *
 * Uses Transformers.js (ONNX via WASM) for local CPU inference.
 * Model: Xenova/all-MiniLM-L6-v2 (22M params, 384 dims, ~80MB)
 *
 * Design principles:
 * - Singleton, lazy initialization (no blocking startup)
 * - Quality filter: only embed substantive content
 * - Graceful degradation: if model fails, return null silently
 * - Batch-friendly: encode() accepts single string or array
 */

import { get_database } from '../../database/connection.js';
import { assertVaultCollectionAllowed } from '../vault/denylist.js';
import { bestCosine, blendedScore } from '../memory/vector-ranking.js';

// Quality filter: skip low-value content that would pollute retrieval
const SKIP_PATTERNS = [
  /^(ok|okay|thanks|thank you|sure|great|nice|cool|awesome|got it|yes|no)$/i,
  /^(hi|hello|hey|good morning|good afternoon|good evening)$/i,
  /^(go on|continue|proceed|next|and then|what else|anything else|tell me more)$/i,
];

export const MIN_CONTENT_LENGTH = 20;
const EMBEDDING_DIMENSION = 384;
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_VERSION = 1;

// Long-document handling (2026-09-25). all-MiniLM-L6-v2 has 512 learned
// positions, so a document was previously truncated at ~512 tokens and
// mean-pooled ONCE: everything past the first window was invisible to search
// (a 3,700-char report is ~1,180 tokens, so two thirds of it never reached its
// vector). Documents are now encoded as overlapping windows whose vectors are
// averaged and re-normalised, so the whole document contributes.
//
// WINDOW_CHARS is measured, not guessed: on the longest real documents in the
// corpus, 1,000-char windows peak at 350 tokens (headroom under 512); 1,500-char
// windows already hit 515 and would truncate.
const WINDOW_CHARS = 1000;
const WINDOW_OVERLAP_CHARS = 100;
const MAX_WINDOWS = 24; // bounds cost: ~22k chars per document
const BATCH_CHUNK = 32; // windows per forward pass in encodeBatch

/** Per-window vectors live beside the fact, not inside it (see storeWindows). */
export const WINDOWS_COLLECTION = 'fact_windows';

interface EmbeddingDocument {
  _id?: any;
  content?: string;
  name?: string;
  narrative?: string;
  fact?: string;
  user_id?: string;
  embedding?: number[];
  embedding_model?: string;
  embedding_version?: number;
  timestamp?: Date | string;
  created_at?: Date | string;
}

export class EmbeddingService {
  private static instance: EmbeddingService;
  private model: any = null;
  private initializing = false;
  private initError: Error | null = null;
  private modelLoaded = false;

  private constructor() {}

  static get_instance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  /** True if the embedding model is loaded and ready for inference. */
  get isReady(): boolean {
    return this.modelLoaded && !!this.model;
  }

  /** The model name used for embeddings. */
  get modelName(): string {
    return MODEL_NAME;
  }

  /** The embedding dimension (vector length). */
  get embeddingDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  /** The embedding version number. */
  get version(): number {
    return EMBEDDING_VERSION;
  }

  /**
   * Lazy-load the embedding model on first use.
   * Downloads ~80MB on first call, then caches.
   */
  private async ensureModel(): Promise<boolean> {
    if (this.modelLoaded && this.model) return true;
    if (this.initError) return false;
    if (this.initializing) {
      // Wait for initialization to complete
      let attempts = 0;
      while (this.initializing && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      return this.modelLoaded && !!this.model;
    }

    // Pre-flight: detect musl/Alpine environments where ONNX runtime will fatal-error.
    // The .node binary needs glibc which doesn't exist on Alpine/musl.
    // Attempting to load it causes an uncatchable ERR_DLOPEN_FAILED that crashes the process.
    try {
      const fs = await import('fs');
      const arch = process.arch;
      // glibc loader paths differ by architecture
      const glibcPaths: Record<string, string> = {
        arm64: '/lib/ld-linux-aarch64.so.1',
        x64: '/lib64/ld-linux-x86-64.so.2',
        // Fallback checks
        x64_alt: '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
      };
      const primaryPath = glibcPaths[arch] || glibcPaths.arm64;
      const altPath = arch === 'x64' ? glibcPaths.x64_alt : null;
      const hasGlibc = fs.existsSync(primaryPath) || (altPath && fs.existsSync(altPath));
      if (!hasGlibc) {
        this.initError = new Error('ONNX runtime requires glibc; Alpine/musl detected. Use a Debian-based image (node:20-slim or node:20).');
        console.warn('⚠️ Embedding disabled: ONNX runtime incompatible with musl libc (Alpine). Vector search unavailable.');
        return false;
      }
    } catch {
      // Non-fatal — proceed to try loading anyway
    }

    this.initializing = true;
    try {
      console.log('🧠 Loading embedding model:', MODEL_NAME);
      const { pipeline } = await import('@xenova/transformers');
      this.model = await pipeline('feature-extraction', MODEL_NAME);
      this.modelLoaded = true;
      console.log('✅ Embedding model loaded:', MODEL_NAME);
      return true;
    } catch (error: any) {
      // Only permanently disable for permanent conditions (glibc/musl mismatch).
      // Transient failures (filesystem race, memory pressure) may succeed on
      // a subsequent call once the container has fully initialized.
      if (this.initError !== null) {
        // Already blocked by glibc check — don't overwrite with transient error
      }
      console.warn('⚠️ Failed to load embedding model (will retry):', error.message);
      return false;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * Quality filter: determine if content is worth embedding.
   * Prevents noise from polluting the vector space.
   */
  shouldEmbed(content: any, eventType?: string): boolean {
    if (!content || typeof content !== 'string') return false;
    if (content.length < MIN_CONTENT_LENGTH) return false;

    const trimmed = content.trim();

    // Skip generic acknowledgments and greetings
    for (const pattern of SKIP_PATTERNS) {
      if (pattern.test(trimmed)) return false;
    }

    // Skip autonomous action noise
    if (eventType === 'AUTONOMOUS_ACTION' && content.length < 50) return false;

    // Skip system/tool-only content without user-facing value
    if (eventType === 'system_message') return false;

    return true;
  }

  /**
   * Split text into embedding windows. Model positions are capped at 512
   * tokens, so anything longer used to be silently truncated; overlapping
   * windows keep whole-document recall at the cost of a few extra forward
   * passes. Exposed for tests.
   */
  splitForEmbedding(text: string): string[] {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    if (trimmed.length <= WINDOW_CHARS) return [trimmed];

    const windows: string[] = [];
    const step = WINDOW_CHARS - WINDOW_OVERLAP_CHARS;
    for (let start = 0; start < trimmed.length && windows.length < MAX_WINDOWS; start += step) {
      windows.push(trimmed.slice(start, start + WINDOW_CHARS));
      if (start + WINDOW_CHARS >= trimmed.length) break;
    }
    return windows;
  }

  /**
   * Mean of per-window vectors, re-normalised to unit length. Returns null if
   * nothing usable came back (the caller then degrades silently, as before).
   */
  private averageVectors(vectors: number[][]): number[] | null {
    const usable = vectors.filter(v => Array.isArray(v) && v.length === EMBEDDING_DIMENSION);
    if (usable.length === 0) return null;

    const acc = new Array<number>(EMBEDDING_DIMENSION).fill(0);
    for (const vec of usable) {
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) acc[i] += vec[i];
    }
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) norm += acc[i] * acc[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return null;
    return acc.map(value => value / norm);
  }

  /**
   * Encode text into a dense vector.
   * Returns null if model unavailable or content fails quality filter.
  /**
   * Encode a document AND keep its window vectors.
   *
   * Window vectors are what makes a long document findable by any part of it
   * (see vector-ranking.ts: scoring takes the best window). Callers that store
   * semantic facts pass `windows` to storeWindows() so the search can use
   * them; everything else keeps calling encode().
   */
  async encodeDocument(
    text: string,
    eventType?: string,
  ): Promise<{ vector: number[]; windows: number[][] } | null> {
    if (!this.shouldEmbed(text, eventType)) return null;

    const modelReady = await this.ensureModel();
    if (!modelReady || !this.model) return null;

    try {
      const windows = this.splitForEmbedding(text);
      if (windows.length === 0) return null;

      if (windows.length > 1) {
        const vectors: number[][] = [];
        for (const window of windows) {
          const out = await this.model(window, {
            pooling: 'mean',
            normalize: true,
          });
          vectors.push(Array.from(out.data as Float32Array));
        }
        const vector = this.averageVectors(vectors);
        return vector ? { vector, windows: vectors } : null;
      }

      const output = await this.model(text, {
        pooling: 'mean',
        normalize: true,
      });
      // output.data is a Float32Array of length 384
      const single = Array.from(output.data as Float32Array);
      return { vector: single, windows: [single] };
    } catch (error: any) {
      console.warn('⚠️ Embedding encoding failed:', error.message);
      return null;
    }
  }

  /** Encode text into a dense vector (the pooled document vector). */
  async encode(text: string, eventType?: string): Promise<number[] | null> {
    const document = await this.encodeDocument(text, eventType);
    return document ? document.vector : null;
  }

  /**
   * Store per-window vectors for a document in `fact_windows`.
   *
   * Kept out of `semantic_facts` on purpose: candidate fetches there pull up
   * to 2,000 full documents per query, and a 24-window array is ~74 KB. The
   * fact only carries the cheap `has_windows` marker (a marker, not a copy of
   * the data) so completeness checks (`has_embedding`) keep their meaning.
   */
  async storeWindows(
    factId: string | any,
    windows: number[][],
    scope: { user_id?: string | null; shared_id?: string | null } = {},
  ): Promise<void> {
    try {
      const db = get_database();
      const collection = db.collection(WINDOWS_COLLECTION);

      if (!Array.isArray(windows) || windows.length < 2) {
        await collection.deleteOne({ fact_id: factId });
        await db.collection('semantic_facts').updateOne(
          { _id: factId },
          { $unset: { has_windows: '', window_count: '' } },
        );
        return;
      }

      await collection.updateOne(
        { fact_id: factId },
        {
          $set: {
            fact_id: factId,
            windows,
            count: windows.length,
            embedding_model: MODEL_NAME,
            embedding_version: EMBEDDING_VERSION,
            updated_at: new Date(),
            ...(scope.user_id ? { user_id: scope.user_id } : {}),
            ...(scope.shared_id ? { shared_id: scope.shared_id } : {}),
          },
        },
        { upsert: true },
      );
      await db.collection('semantic_facts').updateOne(
        { _id: factId },
        { $set: { has_windows: true, window_count: windows.length } },
      );
    } catch (error: any) {
      console.warn('⚠️ Failed to store window vectors:', error.message);
    }
  }

  /** Window vectors for the given fact ids, keyed by fact id. */
  async fetchWindows(factIds: Array<string | any>): Promise<Map<string, number[][]>> {
    const ids = (factIds || []).filter(Boolean);
    if (ids.length === 0) return new Map();
    try {
      const db = get_database();
      const docs = await db
        .collection(WINDOWS_COLLECTION)
        .find({ fact_id: { $in: ids } }, { projection: { fact_id: 1, windows: 1 } })
        .toArray();
      return new Map(docs.map((doc: any) => [String(doc.fact_id), (doc.windows || []) as number[][]]));
    } catch (error: any) {
      console.warn('⚠️ Failed to load window vectors:', error.message);
      return new Map();
    }
  }

  /**
   * Batch encode multiple texts efficiently.
   * Returns array of vectors (null for skipped/failed items).
   */
  async encodeBatch(texts: Array<{ text: string; eventType?: string }>): Promise<(number[] | null)[]> {
    const modelReady = await this.ensureModel();
    if (!modelReady) return texts.map(() => null);

    // Filter qualifying texts, tracking original positions
    const qualified: Array<{ idx: number; text: string }> = [];
    for (let i = 0; i < texts.length; i++) {
      if (this.shouldEmbed(texts[i].text, texts[i].eventType)) {
        qualified.push({ idx: i, text: texts[i].text });
      }
    }

    if (qualified.length === 0) return texts.map(() => null);

    try {
      // Expand each document into its embedding windows, then run the model in
      // bounded chunks — one document can be up to MAX_WINDOWS windows, and
      // batching every window of every document in one call could exhaust
      // memory on the CPU path. ~10-50x throughput vs sequential per chunk.
      const flat: Array<{ idx: number; text: string }> = [];
      for (const q of qualified) {
        const windows = this.splitForEmbedding(q.text);
        for (const window of windows.length > 0 ? windows : [q.text]) {
          flat.push({ idx: q.idx, text: window });
        }
      }

      const perDoc = new Map<number, number[][]>();
      for (let start = 0; start < flat.length; start += BATCH_CHUNK) {
        const slice = flat.slice(start, start + BATCH_CHUNK);
        const output = await this.model(slice.map(item => item.text), {
          pooling: 'mean',
          normalize: true,
        });
        const vectors: number[][] = output.tolist();
        for (let j = 0; j < slice.length; j++) {
          const bucket = perDoc.get(slice[j].idx) ?? [];
          bucket.push(vectors[j]);
          perDoc.set(slice[j].idx, bucket);
        }
      }

      // Map back to original positions, null for skipped items
      const results: (number[] | null)[] = new Array(texts.length).fill(null);
      for (const [idx, vectors] of perDoc) {
        results[idx] = vectors.length === 1 ? vectors[0] : this.averageVectors(vectors);
      }
      return results;
    } catch (error: any) {
      console.warn('⚠️ Batch embedding failed:', error.message);
      return texts.map(() => null);
    }
  }

  /**
   * Cosine similarity between two vectors.
   * Returns value between -1 and 1 (higher = more similar).
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Compute time decay score for a document timestamp.
   * 1.0 at day 0, 0.5 at day ~7, 0.1 at day ~30.
   */
  timeDecayScore(timestamp: Date | string): number {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const days = ageMs / (1000 * 60 * 60 * 24);
    return Math.exp(-days / 10);
  }

  /**
   * Combined ranking score: semantic similarity + recency.
   */
  combinedScore(cosineSim: number, timestamp: Date | string, semanticWeight = 0.6): number {
    const decay = this.timeDecayScore(timestamp);
    return (cosineSim * semanticWeight) + (decay * (1 - semanticWeight));
  }

  /**
   * Store embedding on an existing document in MongoDB.
   * Non-blocking: logs warning on failure, never throws.
   *
   * @param collection — MongoDB collection name
   * @param documentId — either a string (used as _id) or an object (used as-is)
   * @param embedding   — the vector to store
   * @param filter      — optional custom filter, overrides the _id default.
   *                       Use when the collection uses a custom id field (e.g. episodic_events)
   */
  async storeEmbedding(
    collection: string,
    documentId: string | any,
    embedding: number[],
    filter?: Record<string, any>,
    options?: { content?: string; scope?: { user_id?: string | null; shared_id?: string | null } }
  ): Promise<void> {
    try {
      const db = get_database();
      const query = filter || { _id: typeof documentId === 'string' ? documentId : documentId };
      await db.collection(collection).updateOne(
        query,
        {
          $set: {
            embedding,
            embedding_model: MODEL_NAME,
            embedding_version: EMBEDDING_VERSION,
            // Boolean marker so "find un-embedded facts" queries are
            // index-friendly. The embedding array itself cannot be indexed
            // (384 floats exceed the index key limit) and $exists scans the
            // whole collection on every background cycle.
            has_embedding: true,
          },
        }
      );

      // Semantic facts also keep their window vectors, so a match anywhere in
      // a long document stays reachable (see vector-ranking.ts). Only long
      // content has more than one window; anything else clears stale windows.
      if (options?.content && collection === 'semantic_facts') {
        const windows = this.splitForEmbedding(options.content);
        if (windows.length > 1) {
          const document = await this.encodeDocument(options.content);
          await this.storeWindows(documentId, document?.windows ?? [], options.scope);
        } else {
          await this.storeWindows(documentId, [], options.scope);
        }
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to store embedding on ${collection}:`, error.message);
    }
  }

  /**
   * Retrieve documents with embeddings for a given user, sorted by semantic similarity.
   * Hybrid approach: optional keyword pre-filter, then vector re-rank.
   */
  async searchSimilar(
    collection: string,
    userId: string,
    queryText: string,
    options: {
      limit?: number;
      keywordFilter?: any;
      semanticWeight?: number;
      maxAgeDays?: number;
    } = {}
  ): Promise<Array<EmbeddingDocument & { score: number }>> {
    const {
      limit = 10,
      keywordFilter = {},
      semanticWeight = 0.6,
      maxAgeDays = 365,
    } = options;

    // Guard (embedding read path): this generic reader returns document
    // content from any named collection; denylisted vault collections must
    // never be read through it. Synchronous and DB-free.
    assertVaultCollectionAllowed(collection, 'embedding-service:searchSimilar');

    const modelReady = await this.ensureModel();
    if (!modelReady) return [];

    const queryVec = await this.encode(queryText);
    if (!queryVec) return [];

    try {
      const db = get_database();

      // Build filter: (optional) user scope + has embedding + optional keyword
      // pre-filter. userId may be empty for cross-user admin search.
      const filterConditions: any[] = [{ embedding: { $exists: true } }];
      if (userId) filterConditions.unshift({ user_id: userId });
      if (Object.keys(keywordFilter).length > 0) {
        filterConditions.push(keywordFilter);
      }
      const baseFilter: any = filterConditions.length > 1
        ? { $and: filterConditions }
        : filterConditions[0];

      // Optional time window
      if (maxAgeDays < 365) {
        const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
        baseFilter.timestamp = { $gte: cutoff };
      }

      // Fetch candidates (brute-force over embedding docs)
      // At 3K-10K scale this is fast enough; add keyword pre-filter for larger datasets
      const candidates = await db.collection(collection)
        .find(baseFilter)
        .project({ content: 1, embedding: 1, timestamp: 1, created_at: 1, name: 1, narrative: 1, fact: 1, user_id: 1, has_windows: 1 })
        .limit(500)
        .toArray();

      // Chunk-aware scoring: the best window of a long document competes with
      // its pooled vector, and recency discounts rather than manufactures a
      // match (shared with the MCP search paths — see vector-ranking.ts).
      const windows =
        collection === 'semantic_facts'
          ? await this.fetchWindows(candidates.filter((doc: any) => doc.has_windows).map((doc: any) => doc._id))
          : new Map<string, number[][]>();

      const scored = candidates
        .map((doc: any) => {
          const cosine = bestCosine(queryVec, doc.embedding, windows.get(String(doc._id)), EMBEDDING_DIMENSION);
          // `semanticWeight` (0.6) maps onto the recency floor of the shared
          // blend: similarity keeps at least that share, recency modulates the rest.
          const floor = Math.min(1, Math.max(0, semanticWeight));
          const score = blendedScore(cosine, doc.timestamp || doc.created_at, floor);
          return { ...doc, score, cosine };
        })
        .filter((doc: any) => doc.cosine > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, limit);

      return scored;
    } catch (error: any) {
      console.warn('⚠️ Vector search failed:', error.message);
      return [];
    }
  }
}

// Singleton export
export const embeddingService = EmbeddingService.get_instance();
