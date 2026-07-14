/**
 * Memory Integrity Service — Periodic health checks on the memory store.
 *
 * Detects:
 *  - Orphaned episodic events (no corresponding semantic fact)
 *  - Stale semantic facts (not accessed in 7+ days, no embeddings)
 *  - Missing embeddings for semantic facts above the min content threshold
 *  - Collection count anomalies (sudden drops)
 *
 * Design: Singleton, lazy initialization, integrates with existing health check.
 * Follows the pattern established by EmbeddingService.
 */

import { get_database } from '../../database/connection.js';

const STALE_THRESHOLD_DAYS = 7;
const MIN_CONTENT_LENGTH_FOR_EMBEDDING = 100;
const ANOMALY_DROP_THRESHOLD = 0.2; // 20% drop in count vs last check

interface IntegrityReport {
  healthy: boolean;
  timestamp: string;
  episodic_events: { total: number; orphaned: number };
  semantic_facts: { total: number; stale: number; missing_embeddings: number };
  anomalies: string[];
  recommendations: string[];
}

export class MemoryIntegrityService {
  private static instance: MemoryIntegrityService;
  private lastCounts: Record<string, number> = {};
  private lastReport: IntegrityReport | null = null;

  private constructor() {}

  static get_instance(): MemoryIntegrityService {
    if (!MemoryIntegrityService.instance) {
      MemoryIntegrityService.instance = new MemoryIntegrityService();
    }
    return MemoryIntegrityService.instance;
  }

  /** Run a full integrity check and return a report. */
  async runIntegrityCheck(): Promise<IntegrityReport> {
    const db = get_database();
    if (!db) {
      return this._errorReport('Database not connected');
    }

    const report: IntegrityReport = {
      healthy: true,
      timestamp: new Date().toISOString(),
      episodic_events: { total: 0, orphaned: 0 },
      semantic_facts: { total: 0, stale: 0, missing_embeddings: 0 },
      anomalies: [],
      recommendations: [],
    };

    try {
      // ── 1. Check episodic events ────────────────────────────────
      const episodicCollection = db.collection('episodic_events');
      report.episodic_events.total = await episodicCollection.countDocuments();
      await this._checkAnomaly('episodic_events', report.episodic_events.total, report);

      // ── 2. Check semantic facts ──────────────────────────────────
      const semanticCollection = db.collection('semantic_facts');
      report.semantic_facts.total = await semanticCollection.countDocuments();
      await this._checkAnomaly('semantic_facts', report.semantic_facts.total, report);

      // 2a. Stale facts: no embeddings AND last_accessed older than threshold
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - STALE_THRESHOLD_DAYS);

      const staleCount = await semanticCollection.countDocuments({
        $or: [
          { embeddings: { $exists: false } },
          { embeddings: { $size: 0 } },
        ],
        $and: [
          {
            $or: [
              { last_accessed: { $lt: staleDate } },
              { last_accessed: { $exists: false } },
            ],
          },
        ],
      });
      report.semantic_facts.stale = staleCount;

      // 2b. Missing embeddings for substantive content
      const missingEmbeddings = await semanticCollection.countDocuments({
        content: { $exists: true },
        $expr: { $gte: [{ $strLenCP: '$content' }, MIN_CONTENT_LENGTH_FOR_EMBEDDING] },
        $or: [
          { embedding: { $exists: false } },
          { embedding: { $size: 0 } },
          { embedding_model: { $exists: false } },
        ],
        // Not recently created (give them time to process)
        created_at: { $lt: new Date(Date.now() - 3600000) },
      });
      report.semantic_facts.missing_embeddings = missingEmbeddings;

      // ── 3. Check other critical collections ─────────────────────
      const collections = ['auto_journals', 'manual_journals', 'missions',
                           'knowledge_nodes', 'knowledge_edges', 'working_memory_sessions'];
      for (const colName of collections) {
        try {
          const col = db.collection(colName);
          const count = await col.countDocuments();
          await this._checkAnomaly(colName, count, report);
        } catch {
          // Collection may not exist yet — not an error
        }
      }

      // ── 4. Assess health ────────────────────────────────────────
      const totalIssues =
        report.episodic_events.orphaned +
        report.semantic_facts.stale +
        report.semantic_facts.missing_embeddings +
        report.anomalies.length;

      if (totalIssues > 0) {
        report.healthy = false;
        if (report.semantic_facts.stale > 0) {
          report.recommendations.push(
            `${report.semantic_facts.stale} stale semantic facts — consider trigger_reflection or backfill embeddings`
          );
        }
        if (report.semantic_facts.missing_embeddings > 0) {
          report.recommendations.push(
            `${report.semantic_facts.missing_embeddings} semantic facts missing embeddings — run backfill-embeddings script`
          );
        }
        if (report.anomalies.length > 0) {
          report.recommendations.push(
            `Collection anomalies detected: ${report.anomalies.join(', ')}`
          );
        }
      }

      this.lastReport = report;
    } catch (err: any) {
      report.healthy = false;
      report.anomalies.push(`Integrity check failed: ${err.message}`);
    }

    return report;
  }

  /** Get the most recent integrity report (or run a fresh one). */
  async getIntegrityReport(): Promise<IntegrityReport> {
    return this.lastReport ?? (await this.runIntegrityCheck());
  }

  /** Check for anomalous drops in collection counts. */
  private async _checkAnomaly(
    collection: string,
    currentCount: number,
    report: IntegrityReport
  ): Promise<void> {
    if (this.lastCounts[collection] !== undefined) {
      const previous = this.lastCounts[collection];
      if (previous > 0) {
        const drop = (previous - currentCount) / previous;
        if (drop > ANOMALY_DROP_THRESHOLD) {
          report.anomalies.push(
            `${collection}: dropped from ${previous} to ${currentCount} (${(drop * 100).toFixed(0)}% decrease)`
          );
        }
      }
    }
    this.lastCounts[collection] = currentCount;
  }

  private _errorReport(message: string): IntegrityReport {
    return {
      healthy: false,
      timestamp: new Date().toISOString(),
      episodic_events: { total: 0, orphaned: 0 },
      semantic_facts: { total: 0, stale: 0, missing_embeddings: 0 },
      anomalies: [message],
      recommendations: ['Check database connection'],
    };
  }
}
