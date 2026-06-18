/**
 * Time-Block Memory Summarizer — Phase 4: Temporal Recall
 *
 * Clusters episodic events into time blocks (day/week/month) and generates
 * concise LLM-powered summaries stored as semantic_facts. Mimics human
 * episodic→semantic memory consolidation.
 *
 * The summarizer is designed to be called via API (manual or cron), not on
 * every chat message — it's CPU/LLM-intensive and runs as a batch job.
 */

import { get_database } from '../database/connection.js';
import { llmService } from './llm-service.js';

interface TimeBlockSummary {
  user_id: string;
  block_type: 'day' | 'week' | 'month';
  block_start: Date;
  block_end: Date;
  event_count: number;
  summary: string;
  top_topics: string[];
  generated_at: Date;
}

interface SummarizeOptions {
  user_id: string;
  block_type?: 'day' | 'week' | 'month';
  lookback_days?: number;
  dry_run?: boolean;
  max_blocks?: number;
}

interface SummarizeResult {
  blocks_processed: number;
  blocks_skipped: number;
  summaries_generated: number;
  summaries: Array<{
    block_label: string;
    event_count: number;
    summary: string;
  }>;
}

export class TimeBlockSummarizer {
  private readonly BLOCK_LABEL_FORMAT: Record<string, Intl.DateTimeFormatOptions> = {
    day: { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' },
    week: { month: 'short', day: 'numeric' }, // "Week of Jun 1"
    month: { month: 'long', year: 'numeric' },
  };

  /**
   * Main entry point: summarise unprocessed time blocks for a user.
   * Idempotent — skips blocks that already have a summary stored.
   */
  async summarizeTimeBlocks(options: SummarizeOptions): Promise<SummarizeResult> {
    const {
      user_id,
      block_type = 'week',
      lookback_days = 90,
      dry_run = false,
      max_blocks = 20,
    } = options;

    const db = get_database();
    const now = new Date();
    const cutoff = new Date(now.getTime() - lookback_days * 24 * 60 * 60 * 1000);

    console.log(`📦 TimeBlockSummarizer: scanning ${block_type} blocks for user ${user_id}, last ${lookback_days} days`);

    // 1. Fetch all events in the lookback window
    const events = await db.collection('episodic_events')
      .find({
        user_id,
        timestamp: { $gte: cutoff, $lte: now },
      })
      .project({
        timestamp: 1,
        event_type: 1,
        'content.message': 1,
        'content.role': 1,
        session_id: 1,
      })
      .sort({ timestamp: 1 })
      .toArray();

    if (events.length === 0) {
      console.log('📭 No events found in lookback window');
      return { blocks_processed: 0, blocks_skipped: 0, summaries_generated: 0, summaries: [] };
    }

    // 2. Group events into time blocks
    const blocks = this.groupIntoBlocks(events, block_type, cutoff, now);

    console.log(`📊 Grouped ${events.length} events into ${blocks.size} ${block_type} blocks`);

    // 3. For each block, check for existing summary, generate if needed
    const summaries: SummarizeResult['summaries'] = [];
    let processed = 0;
    let skipped = 0;
    let generated = 0;

    for (const [blockKey, blockEvents] of blocks) {
      if (processed >= max_blocks) {
        console.log(`⏹️ Reached max_blocks limit (${max_blocks})`);
        break;
      }
      processed++;

      const [blockStart, blockEnd] = this.getBlockBoundaries(blockEvents, block_type);

      // Check for existing summary
      const existing = await db.collection('semantic_facts').findOne({
        user_id,
        fact_type: 'time_block_summary',
        'metadata.block_type': block_type,
        'metadata.block_start': blockStart,
        'metadata.block_end': blockEnd,
      });

      if (existing) {
        skipped++;
        console.log(`⏭️  Skipping ${blockKey} — summary already exists`);
        continue;
      }

      // Generate summary
      const blockLabel = this.formatBlockLabel(blockStart, blockEnd, block_type);
      const summary = await this.generateBlockSummary(
        user_id,
        blockLabel,
        blockEvents,
        blockStart,
        blockEnd
      );

      if (!dry_run && summary) {
        await this.storeSummary({
          user_id,
          block_type,
          block_start: blockStart,
          block_end: blockEnd,
          event_count: blockEvents.length,
          summary,
          top_topics: this.extractTopics(blockEvents),
          generated_at: new Date(),
        });
      }

      summaries.push({
        block_label: blockLabel,
        event_count: blockEvents.length,
        summary: summary || '(no summary generated)',
      });

      generated++;
      console.log(`✅ Summarised ${blockKey}: ${summary?.substring(0, 80)}...`);
    }

    console.log(`📦 Done: ${generated} generated, ${skipped} skipped, ${processed} total`);
    return { blocks_processed: processed, blocks_skipped: skipped, summaries_generated: generated, summaries };
  }

  /**
   * Query existing time-block summaries within a date range.
   */
  async getTimeBlockSummaries(
    user_id: string,
    from: Date,
    to: Date,
    options: { block_type?: 'day' | 'week' | 'month'; limit?: number } = {}
  ): Promise<TimeBlockSummary[]> {
    const db = get_database();
    const { block_type, limit = 20 } = options;

    const query: any = {
      user_id,
      fact_type: 'time_block_summary',
      'metadata.block_start': { $gte: from },
      'metadata.block_end': { $lte: to },
    };

    if (block_type) {
      query['metadata.block_type'] = block_type;
    }

    const docs = await db.collection('semantic_facts')
      .find(query)
      .sort({ 'metadata.block_start': -1 })
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      user_id: doc.user_id,
      block_type: doc.metadata?.block_type || 'day',
      block_start: doc.metadata?.block_start,
      block_end: doc.metadata?.block_end,
      event_count: doc.metadata?.event_count || 0,
      summary: typeof doc.content === 'string' ? doc.content : JSON.stringify(doc.content),
      top_topics: doc.metadata?.top_topics || [],
      generated_at: doc.metadata?.summary_generated_at || doc.metadata?.created_at,
    }));
  }

  // ── Private helpers ──

  /**
   * Group events into time blocks. Returns a Map keyed by block label
   * (e.g. "2026-06-07" for days, "2026-W23" for weeks, "2026-06" for months).
   */
  private groupIntoBlocks(
    events: any[],
    blockType: string,
    cutoff: Date,
    now: Date
  ): Map<string, any[]> {
    const blocks = new Map<string, any[]>();

    for (const event of events) {
      const ts = new Date(event.timestamp);
      const key = this.getBlockKey(ts, blockType);
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key)!.push(event);
    }

    return blocks;
  }

  private getBlockKey(date: Date, blockType: string): string {
    switch (blockType) {
      case 'day':
        return date.toISOString().slice(0, 10); // "2026-06-07"
      case 'week': {
        // ISO week number
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Thursday of this week
        const week1 = new Date(d.getFullYear(), 0, 4); // Jan 4th is always in week 1
        const weekNum = Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7) + 1) / 7) + 1;
        return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      }
      case 'month':
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      default:
        return date.toISOString().slice(0, 10);
    }
  }

  /**
   * Get the actual start and end dates for a block of events.
   */
  private getBlockBoundaries(
    events: any[],
    blockType: string
  ): [Date, Date] {
    const timestamps = events.map((e) => new Date(e.timestamp).getTime());
    const min = new Date(Math.min(...timestamps));
    const max = new Date(Math.max(...timestamps));

    // Extend to block boundaries
    min.setHours(0, 0, 0, 0);
    max.setHours(23, 59, 59, 999);

    return [min, max];
  }

  /**
   * Generate a human-readable label for a time block.
   */
  private formatBlockLabel(start: Date, end: Date, blockType: string): string {
    switch (blockType) {
      case 'day':
        return start.toLocaleDateString('en-US', this.BLOCK_LABEL_FORMAT.day);
      case 'week':
        return `Week of ${start.toLocaleDateString('en-US', this.BLOCK_LABEL_FORMAT.week)}`;
      case 'month':
        return start.toLocaleDateString('en-US', this.BLOCK_LABEL_FORMAT.month);
      default:
        return `${start.toISOString()} → ${end.toISOString()}`;
    }
  }

  /**
   * Use LLM to summarise events in a time block.
   */
  private async generateBlockSummary(
    user_id: string,
    blockLabel: string,
    events: any[],
    blockStart: Date,
    blockEnd: Date
  ): Promise<string | null> {
    if (!llmService.isServiceAvailable()) {
      console.warn('⚠️ LLM not available — skipping summary generation');
      return this.fallbackSummary(events, blockLabel);
    }

    // Build a compact event list for the LLM
    const eventLines = events.slice(0, 100).map((e) => {
      const ts = new Date(e.timestamp).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const role = e.content?.role || e.event_type || 'system';
      const msg = (e.content?.message || JSON.stringify(e.content))
        .substring(0, 200)
        .replace(/\n/g, ' ');
      return `[${ts}] ${role}: ${msg}`;
    }).join('\n');

    const systemPrompt = `You are a memory consolidation system. Your task is to summarize a user's activity during a specific time period based on their conversation events. Be concise, factual, and focus on what the user was working on or discussing.`;

    const userPrompt = `Summarize what this user was focused on during this time block. Max 3 sentences.

TIME BLOCK: ${blockLabel}
EVENTS: ${events.length}

EVENT LOG:
${eventLines}

SUMMARY:`;

    try {
      const response = await llmService.generateResponse(userPrompt, systemPrompt);
      return response?.trim() || null;
    } catch (error) {
      console.error(`❌ LLM summarization failed for ${blockLabel}:`, error);
      return this.fallbackSummary(events, blockLabel);
    }
  }

  /**
   * Fallback summary without LLM: topic frequency analysis.
   */
  private fallbackSummary(events: any[], blockLabel: string): string {
    const topics = this.extractTopics(events);
    const topTopics = topics.slice(0, 4).join(', ');
    return `${blockLabel}: ${events.length} events. Main topics: ${topTopics || 'general conversation'}.`;
  }

  /**
   * Extract the most frequent topics from a set of events.
   */
  private extractTopics(events: any[]): string[] {
    const wordFreq = new Map<string, number>();
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'can', 'shall', 'i', 'you',
      'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
      'them', 'my', 'your', 'his', 'our', 'their', 'this', 'that',
      'these', 'those', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
      'from', 'by', 'about', 'as', 'into', 'through', 'during',
      'not', 'no', 'just', 'very', 'too', 'so', 'and', 'or', 'but',
    ]);

    for (const event of events) {
      const text = (event.content?.message || '').toLowerCase();
      const words = text.split(/\W+/).filter((w: string) => w.length > 3 && !stopWords.has(w));
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    return Array.from(wordFreq.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([word]) => word);
  }

  /**
   * Store a time-block summary as a semantic_fact.
   */
  private async storeSummary(summary: TimeBlockSummary): Promise<void> {
    const db = get_database();

    await db.collection('semantic_facts').insertOne({
      user_id: summary.user_id,
      fact_type: 'time_block_summary',
      content: summary.summary,
      topic: `time_block_${summary.block_type}`,
      confidence: 0.7,
      metadata: {
        block_type: summary.block_type,
        block_start: summary.block_start,
        block_end: summary.block_end,
        event_count: summary.event_count,
        top_topics: summary.top_topics,
        summary_generated_at: summary.generated_at,
      },
      created_at: new Date(),
      updated_at: new Date(),
    });

    console.log(`💾 Stored summary for ${summary.block_type} block: ${summary.event_count} events`);
  }
}

// Singleton
export const timeBlockSummarizer = new TimeBlockSummarizer();
