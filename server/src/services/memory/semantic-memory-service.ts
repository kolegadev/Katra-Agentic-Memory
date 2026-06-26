/**
 * Semantic Memory Service — Knowledge Graph Compaction Layer
 *
 * Extracts entity-relationship triplets from episodic chat content via DeepSeek
 * and incrementally upserts nodes/edges in MongoDB. Acts as the local compute
 * layer between the cloud LLM and the Pi 5's local graph store.
 *
 * Architecture:
 *   Episodic text → DeepSeek (triplet extraction) → local MongoDB upsert
 */

import { Db } from 'mongodb';
import { llmService } from './llm-service.js';

export interface Triplet {
  source: string;
  sourceType: string;
  relationship: string;
  target: string;
  targetType: string;
}

/** Node document stored in memory_nodes collection */
export interface MemoryNode {
  _id: string;
  user_id: string;
  label: string;
  type: string;
  attributes: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** Edge document stored in memory_edges collection */
export interface MemoryEdge {
  _id: string;
  user_id: string;
  source: string;
  target: string;
  relationship: string;
  weight: number;
  confidence: number;
  source_episodic_ids: string[];
  updated_at: Date;
}

export class SemanticMemoryService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Orchestrates extraction and local DB upsert for a single episodic turn.
   */
  public async compactEpisodicToGraph(userId: string, episodicId: string, textContent: string): Promise<void> {
    assertUserId(userId);
    const triplets = await this.extractTripletsViaLLM(textContent);

    if (triplets.length === 0) {
      console.log('📊 No triplets extracted from episodic content');
      return;
    }

    console.log(`📊 Extracted ${triplets.length} triplets, upserting to graph...`);

    for (const triplet of triplets) {
      await this.upsertTriplet(userId, episodicId, triplet);
    }

    console.log(`📊 Graph compaction complete for ${episodicId}: ${triplets.length} relationships stored`);
  }

  /**
   * Incremental upsert of a single triplet into MongoDB.
   * Node IDs incorporate user_id for tenant isolation.
   * Edge weights are incremented on repeated mentions.
   */
  private async upsertTriplet(userId: string, episodicId: string, triplet: Triplet): Promise<void> {
    const sourceId = this.normalizeNodeId(userId, triplet.source);
    const targetId = this.normalizeNodeId(userId, triplet.target);
    const now = new Date();

    // 1. Upsert Source Node
    await this.db.collection('memory_nodes').updateOne(
      { _id: sourceId },
      {
        $set: { label: triplet.source, type: triplet.sourceType, updated_at: now },
        $setOnInsert: { user_id: userId, created_at: now, attributes: {} },
      },
      { upsert: true }
    );

    // 2. Upsert Target Node
    await this.db.collection('memory_nodes').updateOne(
      { _id: targetId },
      {
        $set: { label: triplet.target, type: triplet.targetType, updated_at: now },
        $setOnInsert: { user_id: userId, created_at: now, attributes: {} },
      },
      { upsert: true }
    );

    // 3. Upsert Edge with Memory Reinforcement (Increment Weight)
    const edgeId = this.buildEdgeId(sourceId, triplet.relationship, targetId);
    await this.db.collection('memory_edges').updateOne(
      { _id: edgeId },
      {
        $set: {
          source: sourceId,
          target: targetId,
          relationship: triplet.relationship.toUpperCase().replace(/\s+/g, '_'),
          updated_at: now,
        },
        $inc: { weight: 1 },
        $addToSet: { source_episodic_ids: episodicId },
        $setOnInsert: { user_id: userId, confidence: 1.0 },
      },
      { upsert: true }
    );
  }

  /**
   * Extracts triplets via llmService.generateResponse().
   * Uses example-driven prompting for reliable DeepSeek JSON output.
   */
  private async extractTripletsViaLLM(textContent: string): Promise<Triplet[]> {
    const extractionContext = `You are a knowledge graph extraction engine.
Extract ALL entity-relationship triplets from the user's text.

Examples:
Text: "I use Python and love React"
{"triplets":[
  {"source":"User","sourceType":"Person","relationship":"USES","target":"Python","targetType":"Language"},
  {"source":"User","sourceType":"Person","relationship":"LOVES","target":"React","targetType":"Tech"}
]}

Entity types allowed: Person, Concept, Tech, Preference, Project, Topic, Tool, Language, Asset, Platform
Relationship format: UPPER_SNAKE_CASE verb (USES, PREFERS, RUNS_ON, BUILT, DISCUSSED, WANTS_TO_LEARN)

CRITICAL: Output ONLY a single JSON object. No markdown, no explanation, no prose.
Start with { and end with }. Nothing before or after.`;

    const extractionPrompt = `Extract triplets from:\n"""\n${textContent.slice(0, 4000)}\n"""`;

    try {
      // Use extractJson which sends a clean system prompt without the
      // "helpful assistant" persona, and tries response_format first.
      const rawResult = await llmService.extractJson(
        extractionContext,
        extractionPrompt,
        1000
      );
      const triplets: Triplet[] = (rawResult as any)?.triplets || [];

      const validTriplets = triplets.filter(
        (t) =>
          typeof t.source === 'string' && t.source.length > 0 &&
          typeof t.target === 'string' && t.target.length > 0 &&
          typeof t.relationship === 'string' && t.relationship.length > 0
      );

      if (validTriplets.length < triplets.length) {
        console.log(`📊 Filtered ${triplets.length - validTriplets.length} malformed triplets`);
      }

      return validTriplets;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`❌ Triplet extraction failed: ${errMsg}`);
      return [];
    }
  }

  /** Normalize a label into a tenant-scoped deduplicated node ID */
  private normalizeNodeId(userId: string, label: string): string {
    const normalizedLabel = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `node_${userId}_${normalizedLabel}`;
  }

  /** Build a deterministic edge ID from source, relationship, and target */
  private buildEdgeId(sourceId: string, relationship: string, targetId: string): string {
    const rel = relationship.toLowerCase().replace(/\s+/g, '_');
    return `edge_${sourceId}_${rel}_${targetId}`;
  }

  /**
   * Return all nodes for a user (for diagnostic / dashboard use).
   */
  public async getAllNodes(userId: string): Promise<MemoryNode[]> {
    assertUserId(userId);
    return this.db.collection('memory_nodes').find({ user_id: userId }).sort({ updated_at: -1 }).limit(100).toArray() as Promise<MemoryNode[]>;
  }

  /**
   * Return top edges by weight for a user.
   */
  public async getTopEdges(userId: string, limit: number = 50): Promise<MemoryEdge[]> {
    assertUserId(userId);
    return this.db.collection('memory_edges').find({ user_id: userId })
      .sort({ weight: -1 })
      .limit(limit)
      .toArray() as Promise<MemoryEdge[]>;
  }
}

/**
 * Guard against accidental cross-tenant queries: MongoDB's find({ user_id: undefined })
 * matches documents where the field is absent, which would re-open the leak.
 */
function assertUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new Error('user_id is required for tenant-scoped graph query');
  }
}
