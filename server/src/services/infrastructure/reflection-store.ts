/**
 * Reflection Store — CRUD operations for sleep consolidation collections.
 * 
 * Manages reflective_journals, reflection_nodes, reflection_edges, and
 * philosophical_insights — the second-order knowledge graph that captures
 * emotional understanding, reflective narrative, and philosophical insight.
 */

import { get_database } from '../../database/connection.js';
import type {
  ReflectiveJournal,
  ReflectionNode,
  ReflectionEdge,
  PhilosophicalInsight,
} from '../../types/memory.js';
import { ObjectId } from 'mongodb';

export class ReflectionStore {
  private static instance: ReflectionStore;

  private constructor() {}

  static get_instance(): ReflectionStore {
    if (!ReflectionStore.instance) {
      ReflectionStore.instance = new ReflectionStore();
    }
    return ReflectionStore.instance;
  }

  // ── Reflective Journals ───────────────────────────────────────────

  async upsertJournal(journal: ReflectiveJournal): Promise<string> {
    const db = get_database();
    const now = new Date();
    const doc = { ...journal, created_at: journal.created_at || now };
    const result = await db.collection('reflective_journals').insertOne(doc);
    return result.insertedId.toString();
  }

  async getLatestJournal(
    userId: string,
    periodType?: string
  ): Promise<ReflectiveJournal | null> {
    const db = get_database();
    const filter: any = { user_id: userId };
    if (periodType) filter.period_type = periodType;
    const doc = await db.collection('reflective_journals')
      .findOne(filter, { sort: { period_start: -1 } });
    return doc as unknown as ReflectiveJournal | null;
  }

  async getJournals(
    userId: string,
    options: {
      periodType?: string;
      limit?: number;
      from?: Date;
      to?: Date;
    } = {}
  ): Promise<ReflectiveJournal[]> {
    const db = get_database();
    const filter: any = { user_id: userId };
    if (options.periodType) filter.period_type = options.periodType;
    if (options.from || options.to) {
      filter.period_start = {};
      if (options.from) filter.period_start.$gte = options.from;
      if (options.to) filter.period_start.$lte = options.to;
    }
    const docs = await db.collection('reflective_journals')
      .find(filter)
      .sort({ period_start: -1 })
      .limit(options.limit || 50)
      .toArray();
    return docs as unknown as ReflectiveJournal[];
  }

  // ── Reflection Nodes ──────────────────────────────────────────────

  async upsertReflectionNode(node: ReflectionNode): Promise<void> {
    const db = get_database();
    const now = new Date();
    // Sanitize entity name to prevent NoSQL injection via field paths
    const safeEntityName = String(node.entity_name).slice(0, 200);
    await db.collection('reflection_nodes').updateOne(
      { user_id: node.user_id, entity_name: safeEntityName },
      {
        $set: {
          entity_type: node.entity_type,
          emotional_signature: node.emotional_signature,
          reflection_context: node.reflection_context,
          last_updated: now,
        },
        $inc: { observation_count: 1 },
        $setOnInsert: {
          first_observed: node.first_observed || now,
          created_at: now,
        },
      },
      { upsert: true }
    );
  }

  async getReflectionNode(
    userId: string,
    entityName: string
  ): Promise<ReflectionNode | null> {
    const db = get_database();
    const doc = await db.collection('reflection_nodes').findOne({
      user_id: userId,
      entity_name: entityName,
    });
    return doc as unknown as ReflectionNode | null;
  }

  async getEmotionalContext(
    userId: string,
    entityName: string
  ): Promise<{ node: ReflectionNode | null; edges: ReflectionEdge[] }> {
    const db = get_database();
    const node = await db.collection('reflection_nodes').findOne({
      user_id: userId,
      entity_name: entityName,
    }) as unknown as ReflectionNode | null;

    const edges = await db.collection('reflection_edges').find({
      user_id: userId,
      $or: [
        { source_entity: entityName },
        { target_entity: entityName },
      ],
    }).sort({ last_updated: -1 }).toArray() as unknown as ReflectionEdge[];

    return { node, edges };
  }

  async getEntitiesByEmotion(
    userId: string,
    emotion: string
  ): Promise<ReflectionNode[]> {
    const db = get_database();
    const docs = await db.collection('reflection_nodes')
      .find({
        user_id: userId,
        'emotional_signature.primary_emotion': emotion,
      })
      .sort({ 'emotional_signature.intensity': -1 })
      .toArray();
    return docs as unknown as ReflectionNode[];
  }

  async getAllReflectionNodes(userId: string): Promise<ReflectionNode[]> {
    const db = get_database();
    const docs = await db.collection('reflection_nodes')
      .find({ user_id: userId })
      .sort({ last_updated: -1 })
      .toArray();
    return docs as unknown as ReflectionNode[];
  }

  // ── Reflection Edges ───────────────────────────────────────────────

  async upsertReflectionEdge(edge: ReflectionEdge): Promise<void> {
    const db = get_database();
    const now = new Date();
    // Sanitize entity names to prevent NoSQL injection via field paths
    const safeSource = String(edge.source_entity).slice(0, 200);
    const safeTarget = String(edge.target_entity).slice(0, 200);
    await db.collection('reflection_edges').updateOne(
      {
        user_id: edge.user_id,
        source_entity: safeSource,
        target_entity: safeTarget,
        edge_type: edge.edge_type,
      },
      {
        $set: {
          intensity: edge.intensity,
          valence: edge.valence,
          narrative: edge.narrative,
          source_journal_id: edge.source_journal_id,
          last_updated: now,
        },
        $setOnInsert: {
          first_observed: edge.first_observed || now,
          created_at: now,
        },
      },
      { upsert: true }
    );
  }

  async getReflectionEdges(
    userId: string,
    options: {
      sourceEntity?: string;
      targetEntity?: string;
      edgeType?: string;
      limit?: number;
    } = {}
  ): Promise<ReflectionEdge[]> {
    const db = get_database();
    const filter: any = { user_id: userId };
    if (options.sourceEntity) filter.source_entity = options.sourceEntity;
    if (options.targetEntity) filter.target_entity = options.targetEntity;
    if (options.edgeType) filter.edge_type = options.edgeType;

    const docs = await db.collection('reflection_edges')
      .find(filter)
      .sort({ intensity: -1 })
      .limit(options.limit || 50)
      .toArray();
    return docs as unknown as ReflectionEdge[];
  }

  // ── Philosophical Insights ─────────────────────────────────────────

  async upsertInsight(insight: PhilosophicalInsight): Promise<void> {
    const db = get_database();
    const now = new Date();
    const existing = await db.collection('philosophical_insights').findOne({
      user_id: insight.user_id,
      insight_text: insight.insight_text,
    }) as unknown as PhilosophicalInsight | null;

    if (existing) {
      // Update: increment evidence, adjust status
      const newCount = (existing.evidence_count || 0) + 1;
      let newStatus = existing.status;
      if (newCount >= 5 && existing.status === 'strengthening') newStatus = 'stable';
      else if (newCount >= 2 && existing.status === 'emerging') newStatus = 'strengthening';

      await db.collection('philosophical_insights').updateOne(
        { _id: existing._id },
        {
          $set: {
            confidence: Math.max(existing.confidence || 0, insight.confidence || 0),
            evidence_count: newCount,
            last_reinforced: now,
            status: newStatus,
            domain: insight.domain || existing.domain,
          },
          $push: {
            source_journal_ids: insight.source_journal_ids?.[0],
          } as any,
        }
      );
    } else {
      await db.collection('philosophical_insights').insertOne({
        ...insight,
        evidence_count: 1,
        first_observed: insight.first_observed || now,
        last_reinforced: insight.last_reinforced || now,
        status: 'emerging',
        source_journal_ids: insight.source_journal_ids || [],
        created_at: now,
      });
    }
  }

  async getInsights(
    userId: string,
    options: {
      domain?: string;
      status?: string;
      limit?: number;
    } = {}
  ): Promise<PhilosophicalInsight[]> {
    const db = get_database();
    const filter: any = { user_id: userId };
    if (options.domain) filter.domain = options.domain;
    if (options.status) filter.status = options.status;

    const docs = await db.collection('philosophical_insights')
      .find(filter)
      .sort({ evidence_count: -1, last_reinforced: -1 })
      .limit(options.limit || 20)
      .toArray();
    return docs as unknown as PhilosophicalInsight[];
  }

  async getUnresolvedThreads(userId: string): Promise<string[]> {
    const db = get_database();
    const latest = await db.collection('reflective_journals')
      .findOne(
        { user_id: userId },
        { sort: { period_start: -1 }, projection: { unresolved_threads: 1 } }
      ) as any;
    const threads: string[] = latest?.unresolved_threads || [];
    if (threads.length === 0) return [];

    // Cross-reference with semantic facts and resolved_threads collection
    // to drop threads that have been explicitly resolved.
    // Resolution facts use "RESOLVED" prefix. Uses token-overlap matching:
    // a thread is resolved if any resolved fact shares >= 2 significant words
    // with the thread text (bidirectional, stop-word filtered).
    try {
      const STOP_WORDS = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
        'should', 'may', 'might', 'must', 'can', 'could', 'of', 'in', 'to',
        'for', 'with', 'on', 'at', 'by', 'from', 'as', 'into', 'through',
        'during', 'before', 'after', 'above', 'below', 'between', 'and',
        'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
        'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
        'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
        'that', 'this', 'these', 'those', 'it', 'its', 'about', 'also',
        'which', 'their', 'them', 'they',
      ]);

      const resolvedFacts = await db.collection('semantic_facts')
        .find({
          user_id: userId,
          content: { $regex: /^RESOLVED/i },
        })
        .project({ content: 1 })
        .toArray() as any[];

      // Also check resolved_threads collection
      const resolvedDocs = await db.collection('resolved_threads')
        .find({ user_id: userId, status: 'resolved' })
        .project({ thread_text: 1 })
        .toArray() as any[];

      const resolvedTexts: string[] = [
        ...resolvedFacts.map((f: any) => f.content?.toLowerCase() || ''),
        ...resolvedDocs.map((d: any) => d.thread_text?.toLowerCase() || ''),
      ];

      if (resolvedTexts.length > 0) {
        return threads.filter(t => {
          const threadLower = t.toLowerCase();
          const threadTokens = new Set(
            threadLower.split(/[^a-z0-9]+/).filter((w: string) => w.length > 2 && !STOP_WORDS.has(w))
          );
          if (threadTokens.size === 0) return true;

          return !resolvedTexts.some((r: string) => {
            const factTokens = new Set(
              r.split(/[^a-z0-9]+/).filter((w: string) => w.length > 2 && !STOP_WORDS.has(w))
            );
            let overlap = 0;
            for (const tok of threadTokens) {
              if (factTokens.has(tok)) overlap++;
            }
            return overlap >= 2 || overlap >= threadTokens.size * 0.5;
          });
        });
      }
    } catch {
      // Non-critical: if cross-reference fails, return threads unfiltered
    }

    return threads;
  }

  async resolveThread(userId: string, threadText: string): Promise<{ resolved: boolean; alreadyResolved: boolean }> {
    const db = get_database();
    const now = new Date();

    // 1. Check if already resolved
    const existing = await db.collection('resolved_threads').findOne({
      user_id: userId,
      thread_text: threadText,
    }) as any;

    if (existing && existing.status === 'resolved') {
      return { resolved: true, alreadyResolved: true };
    }

    // 2. Store in resolved_threads collection
    await db.collection('resolved_threads').updateOne(
      { user_id: userId, thread_text: threadText },
      {
        $set: {
          status: 'resolved',
          resolved_at: now,
          thread_text: threadText,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true }
    );

    // 3. Store a semantic fact for cross-reference (belt + suspenders)
    await db.collection('semantic_facts').insertOne({
      user_id: userId,
      content: 'RESOLVED THREAD: ' + threadText,
      category: 'fact',
      source: 'resolve_thread_tool',
      confidence: 1.0,
      tags: ['resolved-thread', 'system-resolution'],
      created_at: now,
      updated_at: now,
    });

    // 4. Remove from the latest reflective journal's unresolved_threads array
    const latest = await db.collection('reflective_journals').findOne(
      { user_id: userId },
      { sort: { period_start: -1 }, projection: { unresolved_threads: 1 } }
    ) as any;

    if (latest?.unresolved_threads) {
      await db.collection('reflective_journals').updateOne(
        { _id: latest._id },
        {
          $pull: { unresolved_threads: threadText } as any,
          $set: { updated_at: now },
        }
      );
    }

    return { resolved: true, alreadyResolved: false };
  }

  async getReflectionArc(
    userId: string,
    entityName: string,
    limit: number = 10
  ): Promise<Array<{ date: Date; emotional_signature: any; narrative_snippet: string }>> {
    const db = get_database();

    // Get edges involving this entity, joined with their source journals
    const edges = await db.collection('reflection_edges')
      .find({
        user_id: userId,
        $or: [{ source_entity: entityName }, { target_entity: entityName }],
      })
      .sort({ last_updated: -1 })
      .limit(limit * 2)
      .toArray() as any[];

    // Get the corresponding journal entries
    const journalIds = [...new Set(edges.map((e: any) => e.source_journal_id).filter(Boolean))];
    const journals = await db.collection('reflective_journals')
      .find({ _id: { $in: journalIds } })
      .sort({ period_start: -1 })
      .limit(limit)
      .toArray() as any[];

    return journals.map((j: any) => {
      const relatedEdge = edges.find((e: any) =>
        e.source_journal_id?.toString() === j._id.toString()
      );
      return {
        date: j.period_start,
        emotional_signature: relatedEdge ? {
          edge_type: relatedEdge.edge_type,
          intensity: relatedEdge.intensity,
          valence: relatedEdge.valence,
          narrative: relatedEdge.narrative,
        } : null,
        narrative_snippet: j.narrative?.substring(0, 200) || '',
      };
    });
  }
}
