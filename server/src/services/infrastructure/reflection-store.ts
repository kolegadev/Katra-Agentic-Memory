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

    // Cross-reference with semantic facts to drop threads that have been
    // explicitly resolved. Resolution facts use "RESOLVED THREAD" prefix.
    try {
      const resolvedFacts = await db.collection('semantic_facts')
        .find({
          user_id: userId,
          content: { $regex: /^RESOLVED/i },
        })
        .project({ content: 1 })
        .toArray() as any[];

      if (resolvedFacts.length > 0) {
        const resolvedPhrases = resolvedFacts
          .map((f: any) => f.content?.toLowerCase() || '');
        return threads.filter(t =>
          !resolvedPhrases.some((r: string) => r.includes(t.toLowerCase().slice(0, 30)))
        );
      }
    } catch {
      // Non-critical: if cross-reference fails, return threads unfiltered
    }

    return threads;
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
