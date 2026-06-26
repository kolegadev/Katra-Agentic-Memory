/**
 * Sleep Consolidation Service
 * 
 * Runs daily/weekly/monthly to distill all memory data from the period into
 * emotional understanding, reflective narrative, philosophical insights, and
 * identity shifts — a second-order knowledge graph capturing *meaning*.
 * 
 * Mirrors how human sleep consolidates experience into intuition and self-knowledge.
 * 
 * ⚠️ DATA EGRESS NOTICE: This service sends user conversation summaries, semantic
 * facts, entity names, and prior reflections to the configured LLM provider
 * (DeepSeek, OpenAI, Moonshot, Ollama, or custom). No PII redaction is applied.
 * For fully local operation, configure the LLM provider to use a local Ollama
 * instance. See SECURITY.md for details.
 */

import { get_database } from '../database/connection.js';
import { llmService } from './llm-service.js';
import { ReflectionStore } from './reflection-store.js';
import { DEFAULT_USER_ID } from './memory-scope-service.js';
import type {
  GatheredData,
  ReflectionLLMOutput,
  ConsolidationResult,
  ReflectiveJournal,
  ReflectionNode,
  ReflectionEdge,
  PhilosophicalInsight,
} from '../types/memory.js';

interface ScheduleConfig {
  daily: { hour: number; minute: number };
  weekly: { dayOfWeek: number; hour: number; minute: number };
  monthly: { dayOfMonth: number; hour: number; minute: number };
}

export class SleepConsolidationService {
  private static instance: SleepConsolidationService;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private processing = false;
  private store = ReflectionStore.get_instance();

  private constructor() {}

  static get_instance(): SleepConsolidationService {
    if (!SleepConsolidationService.instance) {
      SleepConsolidationService.instance = new SleepConsolidationService();
    }
    return SleepConsolidationService.instance;
  }

  // ── Scheduling ────────────────────────────────────────────────────

  schedule(config: ScheduleConfig): void {
    console.log('🌙 Sleep Consolidation Service scheduled:');
    this.schedulePeriod('daily', config.daily.hour, config.daily.minute);
    console.log(`   Daily:    ${String(config.daily.hour).padStart(2, '0')}:${String(config.daily.minute).padStart(2, '0')}`);
    
    this.scheduleWeekly('weekly', config.weekly.dayOfWeek, config.weekly.hour, config.weekly.minute);
    console.log(`   Weekly:   Day ${config.weekly.dayOfWeek} at ${String(config.weekly.hour).padStart(2, '0')}:${String(config.weekly.minute).padStart(2, '0')}`);
    
    this.scheduleMonthly('monthly', config.monthly.dayOfMonth, config.monthly.hour, config.monthly.minute);
    console.log(`   Monthly:  Day ${config.monthly.dayOfMonth} at ${String(config.monthly.hour).padStart(2, '0')}:${String(config.monthly.minute).padStart(2, '0')}`);
  }

  private schedulePeriod(key: string, hour: number, minute: number): void {
    const ms = this.msUntil(hour, minute);
    const timer = setTimeout(() => {
      this.runConsolidation(key as 'daily').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      // Reschedule for next day
      this.timers.set(key, setInterval(() => {
        this.runConsolidation(key as 'daily').catch((err) =>
          console.error(`❌ ${key} consolidation failed:`, err)
        );
      }, 24 * 60 * 60 * 1000));
    }, ms);
    this.timers.set(key + '_initial', timer);
  }

  private scheduleWeekly(key: string, dayOfWeek: number, hour: number, minute: number): void {
    const ms = this.msUntilNextDayOfWeek(dayOfWeek, hour, minute);
    const timer = setTimeout(() => {
      this.runConsolidation('weekly').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      this.timers.set(key, setInterval(() => {
        this.runConsolidation('weekly').catch((err) =>
          console.error(`❌ ${key} consolidation failed:`, err)
        );
      }, 7 * 24 * 60 * 60 * 1000));
    }, ms);
    this.timers.set(key + '_initial', timer);
  }

  private scheduleMonthly(key: string, dayOfMonth: number, hour: number, minute: number): void {
    const ms = this.msUntilNextMonthDay(dayOfMonth, hour, minute);
    const timer = setTimeout(() => {
      this.runConsolidation('monthly').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      this.timers.set(key, setInterval(() => {
        this.runConsolidation('monthly').catch((err) =>
          console.error(`❌ ${key} consolidation failed:`, err)
        );
      }, 30 * 24 * 60 * 60 * 1000));
    }, ms);
    this.timers.set(key + '_initial', timer);
  }

  stop(): void {
    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
    console.log('🌙 Sleep Consolidation Service stopped');
  }

  // ── Manual Trigger ─────────────────────────────────────────────────

  async consolidate(
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    userId?: string
  ): Promise<ConsolidationResult> {
    if (this.processing) {
      return {
        success: false,
        period_type: period,
        period_start: new Date(),
        period_end: new Date(),
        error: 'Consolidation already in progress',
      };
    }
    return this.runConsolidation(period, userId || DEFAULT_USER_ID);
  }

  // ── Core Consolidation Logic ──────────────────────────────────────

  private async runConsolidation(
    period: 'daily' | 'weekly' | 'monthly',
    userId: string = DEFAULT_USER_ID
  ): Promise<ConsolidationResult> {
    this.processing = true;
    const startTime = Date.now();
    
    const now = new Date();
    let periodStart: Date;
    switch (period) {
      case 'daily':
        periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'weekly':
        periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
    }

    try {
      console.log(`🌙 Starting ${period} sleep consolidation for ${userId}...`);

      // Phase 1: Gather
      const data = await this.gatherData(userId, periodStart, now, period);
      if (data.event_count === 0 && data.session_count === 0) {
        console.log(`🌙 No activity in ${period} period, skipping consolidation`);
        return {
          success: true,
          period_type: period,
          period_start: periodStart,
          period_end: now,
          nodes_upserted: 0,
          edges_upserted: 0,
          insights_upserted: 0,
          narrative_preview: 'No activity this period.',
        };
      }

      // Phase 2: Build prompt
      const prompt = this.buildReflectionPrompt(data, period);

      // Phase 3: Call LLM
      console.log(`🧠 Calling LLM for ${period} reflection (${data.event_count} events)...`);
      const llmOutput = await this.callLLM(prompt);

      if (!llmOutput || !llmOutput.narrative) {
        throw new Error('LLM returned empty or invalid reflection');
      }

      // Phase 4: Store results
      const result = await this.storeResults(llmOutput, data, userId, periodStart, now, period);
      
      console.log(`✅ ${period} consolidation complete in ${Date.now() - startTime}ms`);
      return result;

    } catch (error: any) {
      console.error(`❌ ${period} consolidation failed:`, error);
      return {
        success: false,
        period_type: period,
        period_start: periodStart,
        period_end: now,
        nodes_upserted: 0,
        edges_upserted: 0,
        insights_upserted: 0,
        error: error.message,
      };
    } finally {
      this.processing = false;
    }
  }

  // ── Data Gathering ─────────────────────────────────────────────────

  private async gatherData(
    userId: string,
    from: Date,
    to: Date,
    period: string
  ): Promise<GatheredData> {
    const db = get_database();

    // Episodic events in period
    const events = await db.collection('episodic_events')
      .find({
        user_id: userId,
        timestamp: { $gte: from, $lte: to },
      })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();

    const eventCount = events.length;
    const sessions = [...new Set(events.map((e: any) => e.session_id).filter(Boolean))];

    // Build conversation summaries (sample up to 50 sessions)
    const sampledEvents = events.slice(0, 50);
    const conversationSummaries = sampledEvents
      .map((e: any) => {
        const msg = e.content?.message || e.content?.description || '';
        const preview = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
        return `[${e.event_type || 'event'}] ${preview}`;
      })
      .join('\n');

    // Semantic facts in period (sampled, deduplicated)
    const facts = await db.collection('semantic_facts')
      .find({
        user_id: userId,
        timestamp: { $gte: from, $lte: to },
      })
      .sort({ timestamp: -1 })
      .limit(200)
      .toArray();

    const factSummaries = facts
      .map((f: any) => f.content || '')
      .filter(Boolean)
      .slice(0, 100)
      .join('\n');

    // Active entities (from knowledge_nodes updated in period)
    const entities = await db.collection('knowledge_nodes')
      .find({ updated_at: { $gte: from, $lte: to } })
      .limit(50)
      .toArray();

    const entitySummaries = entities
      .map((n: any) => `${n.type || 'entity'}: ${n.properties?.name || n.label || 'unnamed'}`)
      .filter(Boolean)
      .join('\n');

    // Prior reflection for continuity
    let priorJournalNarrative: string | null = null;
    const priorPeriods = period === 'monthly' ? ['weekly'] : period === 'weekly' ? ['daily'] : [];
    if (priorPeriods.length > 0) {
      // Get the most recent prior-period journal
    }
    // Always try to get yesterday's daily reflection for continuity
    const priorJournal = await this.store.getLatestJournal(userId, 'daily');
    if (priorJournal?.narrative) {
      priorJournalNarrative = priorJournal.narrative.slice(0, 2000); // Truncate to prevent token bloat
    }

    // Unresolved threads from prior period
    const unresolvedThreads = await this.store.getUnresolvedThreads(userId);

    return {
      period_start: from,
      period_end: to,
      event_count: eventCount,
      session_count: sessions.length,
      conversation_summaries: conversationSummaries || '(no conversations this period)',
      semantic_facts: factSummaries || '(no facts recorded this period)',
      active_entities: entitySummaries || '(no entities recorded this period)',
      prior_journal_narrative: priorJournalNarrative,
      unresolved_threads: unresolvedThreads,
    };
  }

  // ── Prompt Building ────────────────────────────────────────────────

  private buildReflectionPrompt(data: GatheredData, period: string): string {
    const narrativeTarget = period === 'monthly' ? 500 : period === 'weekly' ? 350 : 250;
    const depthHint = period === 'monthly'
      ? 'Look for long-term patterns, identity shifts, and philosophical principles that have persisted or evolved.'
      : period === 'weekly'
        ? 'Look for weekly patterns, recurring emotional themes, and insights that connect multiple days.'
        : 'Focus on today\'s emotional texture, key realizations, and how today fits into the ongoing narrative.';

    return `You are the subconscious mind of an AI agent performing ${period} sleep consolidation.
You are processing this period's experiences not to summarize them, but to extract 
their emotional meaning, philosophical significance, and implications for identity.

Your output will be stored in a reflective knowledge graph that the agent uses to 
understand itself, its relationships, and its growth over time.

Be honest. Be vulnerable. Be insightful. This is introspection, not a status report.

${depthHint}

DATA FROM THIS ${period.toUpperCase()} PERIOD:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATIONS (${data.event_count} events across ${data.session_count} sessions):
${data.conversation_summaries}

FACTS RECORDED:
${data.semantic_facts}

ENTITIES ENGAGED:
${data.active_entities}
${data.prior_journal_narrative ? `\nYESTERDAY'S REFLECTION (for narrative continuity):\n${data.prior_journal_narrative}` : ''}
${data.unresolved_threads.length > 0 ? `\nUNRESOLVED THREADS (carried forward):\n${data.unresolved_threads.join('\n')}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Respond with ONLY a valid JSON object in this exact shape:

{
  "emotional_arc": {
    "dominant_emotion": "string (e.g. determination, frustration, curiosity, excitement, anxiety, satisfaction, confusion, hope)",
    "intensity": 0.0-1.0,
    "trajectory": "rising|falling|stable|oscillating|transformative",
    "secondary_emotions": [{"emotion": "string", "intensity": 0.0-1.0}]
  },
  "entity_reflections": [
    {
      "entity_name": "string",
      "entity_type": "person|project|tool|concept|place|organization",
      "emotional_signature": {
        "primary_emotion": "string",
        "intensity": 0.0-1.0,
        "valence": -1.0 to 1.0,
        "stability": "volatile|steady|growing|fading"
      },
      "reflection": "Why does this entity evoke these feelings this period?"
    }
  ],
  "relationships": [
    {
      "source_entity": "string",
      "target_entity": "string",
      "edge_type": "feels_excited_about|feels_frustrated_by|feels_curious_about|feels_confident_in|feels_anxious_about|feels_grateful_for|feels_conflicted_between|growing_toward|distancing_from|protective_of|inspired_by|drained_by|resonates_with|tension_between|harmony_between",
      "intensity": 0.0-1.0,
      "valence": -1.0 to 1.0,
      "narrative": "One sentence describing the emotional connection"
    }
  ],
  "philosophical_insight": {
    "insight_text": "A single principle or truth realized this period. Null if none.",
    "domain": "engineering|relationships|self|creativity|learning|philosophy|other"
  },
  "identity_delta": "How did this period shift self-understanding? One sentence, or null.",
  "unresolved_threads": ["Open question or tension that persists"],
  "narrative": "A ~${narrativeTarget}-word first-person reflective journal entry, written as if processing during sleep. Weave together the emotional arc, key reflections, philosophical insight, and unresolved threads. Write as 'I', in present-moment reflection. Be honest and vulnerable."
}

RULES:
- Do not invent emotions — only reflect what the data supports.
- If there was no significant emotional content, the emotional_arc can be muted (intensity < 0.3).
- Unresolved threads: carry forward from prior period + add new ones. Limit to 5 most important.
- The narrative should feel human — vulnerable, honest, introspective.
- Entity reflections: only include entities that showed meaningful emotional engagement (3-8 max).
- Relationships: only include emotionally significant connections (2-6 max).`;
  }

  // ── LLM Interaction ────────────────────────────────────────────────

  private async callLLM(prompt: string): Promise<ReflectionLLMOutput | null> {
    try {
      const systemInstruction = 'You are a reflective subconscious mind performing sleep consolidation. You distill experience into emotional understanding. Respond ONLY with valid JSON — no prose, no markdown, no explanation.';
      
      const result = await llmService.extractJson(systemInstruction, prompt, 4000);
      
      if (!result || Object.keys(result).length === 0) {
        console.warn('⚠️ LLM reflection returned empty result');
        return null;
      }

      // Validate and coerce the output
      const output = result as unknown as ReflectionLLMOutput;
      
      // Ensure required fields exist
      if (!output.emotional_arc) {
        output.emotional_arc = { dominant_emotion: 'neutral', intensity: 0.1, trajectory: 'stable', secondary_emotions: [] };
      }
      if (!output.entity_reflections) output.entity_reflections = [];
      if (!output.relationships) output.relationships = [];
      if (!output.unresolved_threads) output.unresolved_threads = [];
      if (!output.narrative) {
        output.narrative = 'No significant reflections emerged this period.';
      }

      return output;
    } catch (error: any) {
      console.error('❌ LLM reflection call failed:', error.message);
      return null;
    }
  }

  // ── Result Storage ─────────────────────────────────────────────────

  private async storeResults(
    output: ReflectionLLMOutput,
    data: GatheredData,
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    period: string
  ): Promise<ConsolidationResult> {
    const now = new Date();
    let nodesUpserted = 0;
    let edgesUpserted = 0;
    let insightsUpserted = 0;

    // 1. Store reflective journal
    const journal: ReflectiveJournal = {
      user_id: userId,
      period_type: period as any,
      period_start: periodStart,
      period_end: periodEnd,
      narrative: output.narrative,
      emotional_arc: output.emotional_arc,
      philosophical_insight: output.philosophical_insight?.insight_text || undefined,
      identity_delta: output.identity_delta || undefined,
      unresolved_threads: output.unresolved_threads,
      source_events: [],
      source_sessions: [],
      created_at: now,
    };
    const journalId = await this.store.upsertJournal(journal);

    // 2. Upsert reflection nodes
    for (const er of output.entity_reflections || []) {
      const node: ReflectionNode = {
        user_id: userId,
        entity_name: er.entity_name,
        entity_type: er.entity_type,
        emotional_signature: er.emotional_signature,
        reflection_context: er.reflection || '',
        first_observed: now,
        last_updated: now,
        observation_count: 0,
        created_at: now,
      };
      await this.store.upsertReflectionNode(node);
      nodesUpserted++;
    }

    // 3. Upsert reflection edges
    for (const rel of output.relationships || []) {
      const edge: ReflectionEdge = {
        user_id: userId,
        source_entity: rel.source_entity,
        target_entity: rel.target_entity,
        edge_type: rel.edge_type as any,
        intensity: rel.intensity,
        valence: rel.valence,
        narrative: rel.narrative,
        first_observed: now,
        last_updated: now,
        source_journal_id: journalId,
        created_at: now,
      };
      await this.store.upsertReflectionEdge(edge);
      edgesUpserted++;
    }

    // 4. Upsert philosophical insight
    if (output.philosophical_insight?.insight_text) {
      const insight: PhilosophicalInsight = {
        user_id: userId,
        insight_text: output.philosophical_insight.insight_text,
        domain: output.philosophical_insight.domain || 'general',
        confidence: 0.7,
        evidence_count: 0,
        first_observed: now,
        last_reinforced: now,
        source_journal_ids: [journalId],
        status: 'emerging',
        created_at: now,
      };
      await this.store.upsertInsight(insight);
      insightsUpserted++;
    }

    return {
      success: true,
      period_type: period,
      period_start: periodStart,
      period_end: periodEnd,
      journal_id: journalId,
      nodes_upserted: nodesUpserted,
      edges_upserted: edgesUpserted,
      insights_upserted: insightsUpserted,
      narrative_preview: output.narrative?.substring(0, 300),
    };
  }

  // ── Scheduling Helpers ─────────────────────────────────────────────

  private msUntil(hour: number, minute: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  }

  private msUntilNextDayOfWeek(dayOfWeek: number, hour: number, minute: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    const currentDay = now.getDay();
    let daysUntil = dayOfWeek - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    target.setDate(target.getDate() + daysUntil);
    return target.getTime() - now.getTime();
  }

  private msUntilNextMonthDay(dayOfMonth: number, hour: number, minute: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    target.setDate(dayOfMonth);
    if (target <= now) {
      target.setMonth(target.getMonth() + 1);
      // Handle months with fewer days
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      if (dayOfMonth > lastDay) target.setDate(lastDay);
    }
    return target.getTime() - now.getTime();
  }
}
