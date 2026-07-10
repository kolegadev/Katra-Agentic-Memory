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

// Quality filter: skip low-value content that would pollute retrieval
const SKIP_PATTERNS = [
  /^(ok|okay|thanks|thank you|sure|great|nice|cool|awesome|got it|yes|no)$/i,
  /^(hi|hello|hey|good morning|good afternoon|good evening)$/i,
  /^(go on|continue|proceed|next|and then|what else|anything else|tell me more)$/i,
];

const MIN_CONTENT_LENGTH = 30;
const EMBEDDING_DIMENSION = 384;
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_VERSION = 1;

interface EmbeddingDocument {
  _id?: any;
  content?: string;
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
   * Encode text into a dense vector.
   * Returns null if model unavailable or content fails quality filter.
   */
  async encode(text: string, eventType?: string): Promise<number[] | null> {
    if (!this.shouldEmbed(text, eventType)) return null;

    const modelReady = await this.ensureModel();
    if (!modelReady || !this.model) return null;

    try {
      const output = await this.model(text, {
        pooling: 'mean',
        normalize: true,
      });
      // output.data is a Float32Array of length 384
      return Array.from(output.data);
    } catch (error: any) {
      console.warn('⚠️ Embedding encoding failed:', error.message);
      return null;
    }
  }

  /**
   * Batch encode multiple texts efficiently.
   * Returns array of vectors (null for skipped/failed items).
   */
  async encodeBatch(texts: Array<{ text: string; eventType?: string }>): Promise<(number[] | null)[]> {
    const modelReady = await this.ensureModel();
    if (!modelReady) return texts.map(() => null);

    const results: (number[] | null)[] = [];
    // Process sequentially to avoid memory pressure on Pi5
    for (const item of texts) {
      if (!this.shouldEmbed(item.text, item.eventType)) {
        results.push(null);
        continue;
      }
      try {
        const output = await this.model(item.text, {
          pooling: 'mean',
          normalize: true,
        });
        results.push(Array.from(output.data));
      } catch (error: any) {
        console.warn('⚠️ Batch embedding item failed:', error.message);
        results.push(null);
      }
    }
    return results;
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
    filter?: Record<string, any>
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
          },
        }
      );
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

    const modelReady = await this.ensureModel();
    if (!modelReady) return [];

    const queryVec = await this.encode(queryText);
    if (!queryVec) return [];

    try {
      const db = get_database();

      // Build filter: user + has embedding + optional keyword pre-filter
      // Use $and to prevent keywordFilter from overriding user_id scoping
      const filterConditions: any[] = [
        { user_id: userId },
        { embedding: { $exists: true } },
      ];
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
        .project({ content: 1, embedding: 1, timestamp: 1, created_at: 1 })
        .limit(500)
        .toArray();

      // Score and rank
      const scored = candidates
        .filter((doc: any) => doc.embedding && doc.embedding.length === EMBEDDING_DIMENSION)
        .map((doc: any) => {
          const cosine = this.cosineSimilarity(queryVec, doc.embedding);
          const ts = doc.timestamp || doc.created_at || new Date();
          const score = this.combinedScore(cosine, ts, semanticWeight);
          return { ...doc, score, cosine };
        })
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
