/**
 * Temporal Resolver Service
 *
 * Dedicated layer for answering "when did X happen?" questions.
 * Resolves temporal queries by searching episodic events and semantic facts
 * with the new source_event_timestamp field, returning structured date results.
 *
 * Created as part of Phase 3 of the memory system temporal upgrade (2026-06-14).
 */

import { get_database } from '../database/connection.js';
import type { Db, Collection } from 'mongodb';

export interface TemporalQueryResult {
  query: string;
  found: boolean;
  source: 'episodic' | 'semantic_fact' | 'both' | 'none';
  events: Array<{
    id: string;
    timestamp: string;       // ISO 8601
    relative_time: string;   // "3 days ago", "last Tuesday"
    content_snippet: string; // First 200 chars of message
    confidence: number;
  }>;
  facts: Array<{
    id: string;
    source_event_timestamp: string; // ISO 8601 — the original event time
    stored_at: string;              // When the fact was extracted
    content: string;
    confidence: number;
  }>;
  summary: string; // Human-readable summary for the LLM to use
}

export class TemporalResolver {
  // Lazy accessors — DB may not be connected at module load time
  private get db(): Db { return get_database(); }
  private get episodicCollection(): Collection { return this.db.collection('episodic_events'); }
  private get factsCollection(): Collection { return this.db.collection('semantic_facts'); }

  /**
   * Resolve a temporal query — find WHEN something happened.
   * Searches both episodic events and semantic facts for the given topic,
   * and returns structured date information.
   */
  async resolveWhen(
    userId: string,
    topic: string,
    options: {
      maxResults?: number;
      fromDate?: Date;
      toDate?: Date;
    } = {}
  ): Promise<TemporalQueryResult> {
    const { maxResults = 5, fromDate, toDate } = options;

    const keywords = this.extractQueryTerms(topic);
    if (keywords.length === 0) {
      return {
        query: topic,
        found: false,
        source: 'none',
        events: [],
        facts: [],
        summary: 'No meaningful keywords extracted from query.'
      };
    }

    // Build date filter
    const dateFilter: any = {};
    if (fromDate || toDate) {
      dateFilter.timestamp = {};
      if (fromDate) dateFilter.timestamp.$gte = fromDate;
      if (toDate) dateFilter.timestamp.$lte = toDate;
    }

    // Search episodic events by keyword
    let events: any[] = [];
    try {
      const orConditions = keywords.map(k => ({
        'content.message': { $regex: k, $options: 'i' }
      }));

      events = await this.episodicCollection
        .find({
          user_id: userId,
          $or: orConditions,
          ...dateFilter
        })
        .sort({ timestamp: -1 })
        .limit(maxResults)
        .toArray();
    } catch (e) {
      console.warn('⚠️ Temporal episodic search failed:', e);
    }

    // Search semantic facts by keyword (including new source_event_timestamp)
    let facts: any[] = [];
    try {
      const factOrConditions = keywords.map(k => ({
        content: { $regex: k, $options: 'i' }
      }));

      facts = await this.factsCollection
        .find({
          user_id: userId,
          $or: factOrConditions
        })
        .sort({ created_at: -1 })
        .limit(maxResults)
        .toArray();
    } catch (e) {
      console.warn('⚠️ Temporal fact search failed:', e);
    }

    // Format results
    const now = Date.now();
    const formattedEvents = events.map(e => ({
      id: e.id || e._id?.toString?.(),
      timestamp: e.timestamp ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Unknown',
      relative_time: this.relativeTime(e.timestamp, now),
      content_snippet: (e.content?.message || '').substring(0, 200),
      confidence: e.metadata?.confidence || e.confidence || 0.8,
    }));

    const formattedFacts = facts.map(f => ({
      id: f._id?.toString?.() || f.id || 'unknown',
      source_event_timestamp: f.source_event_timestamp
        ? new Date(f.source_event_timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        : (f.timestamp
          ? new Date(f.timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
          : (f.created_at
            ? new Date(f.created_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
            : 'Unknown')),
      stored_at: f.created_at ? new Date(f.created_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Unknown',
      content: (f.content || '').substring(0, 300),
      confidence: f.confidence || 0.7,
    }));

    const source = (events.length > 0 && facts.length > 0) ? 'both'
      : events.length > 0 ? 'episodic'
      : facts.length > 0 ? 'semantic_fact'
      : 'none';

    const summary = this.buildSummary(formattedEvents, formattedFacts, topic);

    return {
      query: topic,
      found: events.length > 0 || facts.length > 0,
      source,
      events: formattedEvents,
      facts: formattedFacts,
      summary,
    };
  }

  /**
   * Format a human-readable temporal context string for injection into the LLM prompt.
   * This is the main method called by the LLM memory curator.
   */
  formatTemporalContext(result: TemporalQueryResult): string {
    if (!result.found) {
      return `[Temporal context: No dated records found for "${result.query}"]`;
    }

    const parts: string[] = [`## Temporal Context — When "${result.query}" happened:`];

    if (result.events.length > 0) {
      parts.push('\n### Conversation Records (most recent first):');
      for (const e of result.events) {
        parts.push(`- **${e.timestamp}** (${e.relative_time}): ${e.content_snippet}`);
      }
    }

    if (result.facts.length > 0) {
      parts.push('\n### Stored Facts (with original event dates):');
      for (const f of result.facts) {
        parts.push(`- Originated **${f.source_event_timestamp}** — ${f.content}`);
      }
    }

    parts.push(`\n### Summary: ${result.summary}`);
    return parts.join('\n');
  }

  /**
   * Extract key terms from a query for keyword search.
   */
  private extractQueryTerms(query: string): string[] {
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
      'for', 'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'have',
      'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
      'may', 'might', 'when', 'what', 'where', 'who', 'how', 'why', 'did', 'we',
      'you', 'i', 'me', 'my', 'your', 'our', 'us', 'about', 'happen', 'happened'];

    return query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2 && !stopWords.includes(term));
  }

  /**
   * Compute a human-readable relative time string.
   */
  private relativeTime(timestamp: any, now: number): string {
    if (!timestamp) return 'unknown';
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 14) return 'last week';
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 60) return 'last month';
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  }

  /**
   * Build a human-readable summary of the temporal search results.
   */
  private buildSummary(
    events: TemporalQueryResult['events'],
    facts: TemporalQueryResult['facts'],
    query: string
  ): string {
    const total = events.length + facts.length;
    if (total === 0) return `No records found for "${query}".`;

    const allTimestamps: string[] = [];
    for (const e of events) allTimestamps.push(e.relative_time);
    for (const f of facts) allTimestamps.push(f.source_event_timestamp);

    const earliest = events.length > 0 ? events[events.length - 1].timestamp : facts[facts.length - 1]?.source_event_timestamp || 'unknown';
    const latest = events.length > 0 ? events[0].timestamp : facts[0]?.source_event_timestamp || 'unknown';

    return `Found ${total} records related to "${query}". Most recent: ${latest}. Earliest: ${earliest}.`;
  }
}

// Export singleton
export const temporalResolver = new TemporalResolver();
