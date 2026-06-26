/**
 * Temporal Pattern Detector — Phase 5: Temporal Recall
 *
 * Detects recurring patterns in user activity over time:
 * - Recurring topic patterns ("Every Monday you work on the trading bot")
 * - Session rhythm ("You tend to have long sessions on weekends")
 * - Topic regression ("This bug looks like one from 3 months ago")
 * - Dormant topics ("It's been 2 weeks since you mentioned X")
 *
 * Designed as a standalone service, callable via API or integrated
 * into the cognitive context pipeline.
 */

import { get_database } from '../database/connection.js';

interface RecurringTopic {
  topic: string;
  day_of_week: string;
  occurrences: number;
  total_weeks: number;
  weeks: string[];
  confidence: number;
}

interface SessionRhythm {
  most_active_days: Array<{ day: string; avg_events: number }>;
  long_session_days: string[];
  short_session_days: string[];
  active_percentage: number;
  pattern_description: string;
}

interface TopicRegression {
  current_topic: string;
  similar_past_topic: string;
  past_date: string;
  days_ago: number;
  similarity_score: number;
}

interface DormantTopic {
  topic: string;
  last_mentioned: string;
  days_since: number;
  total_discussions: number;
  peak_day: string;
}

export interface DetectedPatterns {
  recurring_topics: RecurringTopic[];
  session_rhythm: SessionRhythm;
  topic_regressions: TopicRegression[];
  dormant_topics: DormantTopic[];
  detected_at: Date;
}

interface DetectOptions {
  user_id: string;
  lookback_weeks?: number;
  min_confidence?: number;
  dormant_threshold_days?: number;
  regression_lookback_days?: number;
}

export class TemporalPatternDetector {
  private readonly STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'i', 'you',
    'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us',
    'them', 'my', 'your', 'his', 'our', 'their', 'this', 'that',
    'these', 'those', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
    'from', 'by', 'about', 'as', 'into', 'through', 'during',
    'not', 'no', 'just', 'very', 'too', 'so', 'and', 'or', 'but',
    'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all',
    'if', 'then', 'than', 'also', 'now', 'more', 'some', 'any',
  ]);

  private readonly DAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ];

  /**
   * Main entry point: detect all temporal patterns for a user.
   */
  async detectPatterns(options: DetectOptions): Promise<DetectedPatterns> {
    const {
      user_id,
      lookback_weeks = 12,
      min_confidence = 0.5,
      dormant_threshold_days = 14,
      regression_lookback_days = 120,
    } = options;

    const db = get_database();
    const now = new Date();
    const cutoff = new Date(now.getTime() - lookback_weeks * 7 * 24 * 60 * 60 * 1000);

    console.log(`🔍 TemporalPatternDetector: scanning ${lookback_weeks} weeks for user ${user_id}`);

    // Fetch all user-message events in the lookback window
    const events = await db.collection('episodic_events')
      .find({
        user_id,
        timestamp: { $gte: cutoff, $lte: now },
        $or: [
          { 'content.role': 'user' },
          { event_type: 'user_message' },
        ],
      })
      .project({ timestamp: 1, 'content.message': 1, session_id: 1 })
      .sort({ timestamp: 1 })
      .toArray();

    if (events.length < 5) {
      console.log('📭 Too few events for pattern detection');
      return this.emptyResult();
    }

    // 1. Detect recurring topics
    const recurring_topics = this.detectRecurringTopics(events, lookback_weeks, min_confidence);

    // 2. Analyze session rhythm
    const session_rhythm = this.analyzeSessionRhythm(events);

    // 3. Detect topic regressions
    const topic_regressions = await this.detectTopicRegressions(
      db, user_id, events, regression_lookback_days
    );

    // 4. Detect dormant topics
    const dormant_topics = await this.detectDormantTopics(
      db, user_id, now, dormant_threshold_days
    );

    console.log(`✅ Patterns detected: ${recurring_topics.length} recurring, ${topic_regressions.length} regressions, ${dormant_topics.length} dormant`);

    return {
      recurring_topics,
      session_rhythm,
      topic_regressions,
      dormant_topics,
      detected_at: now,
    };
  }

  /**
   * Detect topics that recur on the same day of week across multiple weeks.
   * E.g., "Every Monday you work on the trading bot"
   */
  private detectRecurringTopics(
    events: any[],
    totalWeeks: number,
    minConfidence: number
  ): RecurringTopic[] {
    const topicByWeekday = new Map<string, Map<string, { count: number; weeks: Set<string> }>>();
    // Map: dayOfWeek -> { topic -> stats }

    for (const event of events) {
      const ts = new Date(event.timestamp);
      const dayOfWeek = this.DAY_NAMES[ts.getDay()];
      const weekKey = this.getWeekKey(ts);
      const message = (event.content?.message || '').toLowerCase();
      const topics = this.extractTopicsFromText(message);

      if (!topicByWeekday.has(dayOfWeek)) {
        topicByWeekday.set(dayOfWeek, new Map());
      }

      const dayMap = topicByWeekday.get(dayOfWeek)!;
      for (const topic of topics) {
        if (!dayMap.has(topic)) {
          dayMap.set(topic, { count: 0, weeks: new Set() });
        }
        const stats = dayMap.get(topic)!;
        stats.count++;
        stats.weeks.add(weekKey);
      }
    }

    const recurring: RecurringTopic[] = [];
    for (const [day, topicMap] of topicByWeekday) {
      for (const [topic, stats] of topicMap) {
        const consistency = stats.weeks.size / Math.max(totalWeeks, 1);
        // Must appear in at least 3 weeks and show some consistency
        if (stats.count >= 3 && stats.weeks.size >= 2 && consistency >= minConfidence * 0.5) {
          recurring.push({
            topic,
            day_of_week: day,
            occurrences: stats.count,
            total_weeks: stats.weeks.size,
            weeks: Array.from(stats.weeks).sort().slice(-5),
            confidence: Math.min(consistency * 2, 1),
          });
        }
      }
    }

    return recurring
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
  }

  /**
   * Analyze session activity patterns: which days are busiest,
   * which have long vs short sessions.
   */
  private analyzeSessionRhythm(events: any[]): SessionRhythm {
    const eventsByDay = new Map<string, number[]>();
    const sessionsByDay = new Map<string, Set<string>>();

    for (const event of events) {
      const ts = new Date(event.timestamp);
      const day = this.DAY_NAMES[ts.getDay()];

      if (!eventsByDay.has(day)) {
        eventsByDay.set(day, []);
        sessionsByDay.set(day, new Set());
      }
      eventsByDay.get(day)!.push(event.timestamp);
      if (event.session_id) {
        sessionsByDay.get(day)!.add(event.session_id);
      }
    }

    // Most active days by event count
    const activityByDay = Array.from(eventsByDay.entries())
      .map(([day, timestamps]) => ({
        day,
        avg_events: Math.round((timestamps.length / 12) * 10) / 10, // normalize by weeks (12)
        session_count: sessionsByDay.get(day)!.size,
      }))
      .sort((a, b) => b.avg_events - a.avg_events);

    const totalEvents = events.length;
    const activeThreshold = totalEvents / 7; // average events per day
    const longSessionDays = activityByDay
      .filter((d) => d.avg_events > activeThreshold * 1.5)
      .map((d) => d.day);
    const shortSessionDays = activityByDay
      .filter((d) => d.avg_events > 0 && d.avg_events < activeThreshold * 0.5)
      .map((d) => d.day);

    // Build description
    let description = '';
    if (longSessionDays.length > 0) {
      description += `Longest sessions on ${longSessionDays.join(', ')}. `;
    }
    if (activityByDay.length > 0) {
      description += `Peak activity: ${activityByDay[0].day} (${activityByDay[0].avg_events} events/week). `;
    }
    const activeDays = eventsByDay.size;
    const activePct = Math.round((activeDays / 7) * 100);
    description += `Active on ${activeDays}/7 days (${activePct}%).`;

    return {
      most_active_days: activityByDay.slice(0, 4),
      long_session_days: longSessionDays,
      short_session_days: shortSessionDays,
      active_percentage: activePct,
      pattern_description: description,
    };
  }

  /**
   * Detect topic regressions — topics from 1-4 months ago that
   * resemble what the user is currently discussing.
   */
  private async detectTopicRegressions(
    db: any,
    user_id: string,
    currentEvents: any[],
    regressionLookbackDays: number
  ): Promise<TopicRegression[]> {
    const now = new Date();
    const pastCutoff = new Date(now.getTime() - regressionLookbackDays * 24 * 60 * 60 * 1000);
    const recentCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Extract current topics from last 7 days
    const recentEvents = currentEvents.filter(
      (e) => new Date(e.timestamp) >= recentCutoff
    );
    const currentTopics = this.extractTopicsFromEvents(recentEvents);

    if (currentTopics.size === 0) return [];

    // Fetch older events for comparison
    const pastEvents = await db.collection('episodic_events')
      .find({
        user_id,
        timestamp: { $gte: pastCutoff, $lt: recentCutoff },
        $or: [{ 'content.role': 'user' }, { event_type: 'user_message' }],
      })
      .project({ timestamp: 1, 'content.message': 1 })
      .sort({ timestamp: -1 })
      .toArray();

    const regressions: TopicRegression[] = [];
    for (const [topic, _freq] of currentTopics) {
      // Find past events mentioning this topic
      const pastMatches = pastEvents.filter((e: any) => {
        const msg = (e.content?.message || '').toLowerCase();
        return msg.includes(topic.toLowerCase());
      });

      if (pastMatches.length >= 2) {
        // Find the earliest mention
        const oldestMatch = pastMatches[pastMatches.length - 1];
        const oldestDate = new Date(oldestMatch.timestamp);
        const daysAgo = Math.round((now.getTime() - oldestDate.getTime()) / (24 * 60 * 60 * 1000));

        if (daysAgo >= 21) {
          regressions.push({
            current_topic: topic,
            similar_past_topic: topic,
            past_date: oldestDate.toISOString(),
            days_ago: daysAgo,
            similarity_score: Math.min(pastMatches.length / 5, 1),
          });
        }
      }
    }

    return regressions
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 5);
  }

  /**
   * Detect dormant topics — projects/topics mentioned 2+ weeks ago
   * but not discussed since.
   */
  private async detectDormantTopics(
    db: any,
    user_id: string,
    now: Date,
    dormantThresholdDays: number
  ): Promise<DormantTopic[]> {
    const dormantCutoff = new Date(now.getTime() - dormantThresholdDays * 24 * 60 * 60 * 1000);

    // Get all events, split by before/after the threshold
    const allEvents = await db.collection('episodic_events')
      .find({
        user_id,
        $or: [{ 'content.role': 'user' }, { event_type: 'user_message' }],
      })
      .project({ timestamp: 1, 'content.message': 1 })
      .sort({ timestamp: -1 })
      .limit(500)
      .toArray();

    if (allEvents.length < 10) return [];

    const recentEvents = allEvents.filter(
      (e) => new Date(e.timestamp) >= dormantCutoff
    );
    const oldEvents = allEvents.filter(
      (e) => new Date(e.timestamp) < dormantCutoff
    );

    const recentTopics = this.extractTopicsFromEvents(recentEvents);
    const oldTopics = this.extractTopicsFromEvents(oldEvents);

    // Topics present in old but absent in recent
    const dormant: DormantTopic[] = [];
    for (const [topic, stats] of oldTopics) {
      if (!recentTopics.has(topic) && stats.count >= 3) {
        const lastDate = new Date(stats.last_seen);
        const daysSince = Math.round((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));

        if (daysSince >= dormantThresholdDays) {
          dormant.push({
            topic,
            last_mentioned: lastDate.toISOString(),
            days_since: daysSince,
            total_discussions: stats.count,
            peak_day: stats.peak_day,
          });
        }
      }
    }

    return dormant
      .sort((a, b) => b.total_discussions - a.total_discussions)
      .slice(0, 8);
  }

  /**
   * Generate a human-readable summary of all detected patterns
   * suitable for injection into the LLM cognitive context.
   */
  summarizePatterns(patterns: DetectedPatterns): string {
    const lines: string[] = [];

    // Recurring topics
    if (patterns.recurring_topics.length > 0) {
      lines.push('🔁 RECURRING TOPIC PATTERNS:');
      for (const p of patterns.recurring_topics.slice(0, 5)) {
        lines.push(
          `  - Every ${p.day_of_week}: "${p.topic}" (${p.occurrences}x in ${p.total_weeks} weeks, ${Math.round(p.confidence * 100)}% confidence)`
        );
      }
      lines.push('');
    }

    // Session rhythm
    if (patterns.session_rhythm.most_active_days.length > 0) {
      lines.push('📊 SESSION RHYTHM:');
      lines.push(`  ${patterns.session_rhythm.pattern_description}`);
      if (patterns.session_rhythm.long_session_days.length > 0) {
        lines.push(`  💡 Deep-focus days: ${patterns.session_rhythm.long_session_days.join(', ')}`);
      }
      lines.push('');
    }

    // Topic regressions
    if (patterns.topic_regressions.length > 0) {
      lines.push('🔄 TOPIC REGRESSIONS (similar discussions from the past):');
      for (const t of patterns.topic_regressions.slice(0, 3)) {
        const pastDate = new Date(t.past_date).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric',
        });
        lines.push(`  - "${t.current_topic}" was also discussed ${t.days_ago}d ago (${pastDate})`);
      }
      lines.push('');
    }

    // Dormant topics
    if (patterns.dormant_topics.length > 0) {
      lines.push('💤 DORMANT TOPICS (not discussed recently):');
      for (const t of patterns.dormant_topics.slice(0, 5)) {
        const lastDate = new Date(t.last_mentioned).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric',
        });
        lines.push(
          `  - "${t.topic}" — last mentioned ${t.days_since}d ago (${lastDate}), discussed ${t.total_discussions}x`
        );
      }
      lines.push('');
    }

    if (lines.length === 0) {
      lines.push('No significant temporal patterns detected in the lookback period.');
    }

    return lines.join('\n');
  }

  // ── Private helpers ──

  private extractTopicsFromText(text: string): string[] {
    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !this.STOP_WORDS.has(w));
    // Count frequencies
    const freq = new Map<string, number>();
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    // Return words that appear more than once or are long (>6 chars, likely meaningful)
    return Array.from(freq.entries())
      .filter(([, count]) => count >= 2)
      .slice(0, 8)
      .map(([word]) => word);
  }

  private extractTopicsFromEvents(events: any[]): Map<string, { count: number; last_seen: string; peak_day: string }> {
    const topicMap = new Map<string, { count: number; last_seen: string; peak_day: string }>();

    for (const event of events) {
      const ts = new Date(event.timestamp);
      const day = this.DAY_NAMES[ts.getDay()];
      const message = (event.content?.message || '').toLowerCase();
      const topics = this.extractTopicsFromText(message);

      for (const topic of topics) {
        if (!topicMap.has(topic)) {
          topicMap.set(topic, { count: 0, last_seen: event.timestamp, peak_day: day });
        }
        const stats = topicMap.get(topic)!;
        stats.count++;
        if (new Date(event.timestamp) > new Date(stats.last_seen)) {
          stats.last_seen = event.timestamp;
          stats.peak_day = day;
        }
      }
    }

    return topicMap;
  }

  private getWeekKey(date: Date): string {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7) + 1) / 7) + 1;
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  }

  private emptyResult(): DetectedPatterns {
    return {
      recurring_topics: [],
      session_rhythm: {
        most_active_days: [],
        long_session_days: [],
        short_session_days: [],
        active_percentage: 0,
        pattern_description: 'Insufficient data for rhythm analysis.',
      },
      topic_regressions: [],
      dormant_topics: [],
      detected_at: new Date(),
    };
  }
}

// Singleton
export const temporalPatternDetector = new TemporalPatternDetector();
