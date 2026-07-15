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

import { get_database } from '../../database/connection.js';
import { consolidationOutputBus } from '../infrastructure/consolidation-output-bus.js';
import { llmService } from '../infrastructure/llm-service.js';
import { ReflectionStore } from '../infrastructure/reflection-store.js';
import { DEFAULT_USER_ID } from '../memory/memory-scope-service.js';
import { DecisionActionService } from './decision-action-service.js';
import type {
  GatheredData,
  ReflectionLLMOutput,
  ConsolidationResult,
  ReflectiveJournal,
  ReflectionNode,
  ReflectionEdge,
  PhilosophicalInsight,
} from '../../types/memory.js';

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

    // Safety net: poll every 30 min to catch missed timer callbacks
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    // Run immediately on startup — catches overdue consolidations right away
    this.checkAndRunOverdue().catch((err) =>
      console.error('❌ checkAndRunOverdue failed:', err)
    );
    setInterval(() => {
      this.checkAndRunOverdue().catch((err) =>
        console.error('❌ checkAndRunOverdue failed:', err)
      );
    }, 30 * 60 * 1000); // every 30 minutes
  }

  private async checkAndRunOverdue(): Promise<void> {
    // Load persisted last-run times from DB on first call (survives restarts)
    await this.loadLastRuns();
    
    const now = new Date();
    const periods: Array<'daily' | 'weekly' | 'monthly'> = ['daily', 'weekly', 'monthly'];
    for (const period of periods) {
      const lastRun = this.lastRunTimes.get(period);

      // If never run, check if we're past the scheduled time
      if (lastRun === undefined) {
        const scheduled = new Date(now);
        if (period === 'daily') {
          scheduled.setHours(2, 0, 0, 0); // 2AM
          // If it's past 2AM, the scheduled time has already passed — run now
          if (now.getHours() >= 2) {
            console.log(`⏰ ${period} first run (past scheduled ${scheduled.toISOString()}), running...`);
            this.runConsolidation(period).catch((err) =>
              console.error(`❌ ${period} consolidation failed:`, err)
            );
          }
        }
        continue;
      }

      const threshold = period === 'daily' ? 25 * 60 * 60 * 1000  // 25h
                      : period === 'weekly' ? 8 * 24 * 60 * 60 * 1000  // 8d
                      : 32 * 24 * 60 * 60 * 1000;  // monthly: 32d
      if (now.getTime() - lastRun > threshold) {
        console.log(`⏰ ${period} consolidation overdue (last: ${new Date(lastRun).toISOString()}), running...`);
        this.runConsolidation(period).catch((err) =>
          console.error(`❌ ${period} consolidation failed:`, err)
        );
      }
    }
  }

  private lastRunTimes: Map<string, number> = new Map();
  private lastRunTimesLoaded = false;

  private async persistLastRun(period: string, timestamp: number): Promise<void> {
    try {
      const db = get_database();
      await db.collection('consolidation_runs').updateOne(
        { period_type: period },
        { $set: { last_run_at: new Date(timestamp), updated_at: new Date() } },
        { upsert: true }
      );
    } catch (err: any) {
      console.warn(`⚠️ Failed to persist ${period} last run:`, err.message);
    }
  }

  private async loadLastRuns(): Promise<void> {
    if (this.lastRunTimesLoaded) return;
    try {
      const db = get_database();
      const docs = await db.collection('consolidation_runs').find({}).toArray();
      for (const doc of docs) {
        if (doc.period_type && doc.last_run_at) {
          const ts = new Date(doc.last_run_at).getTime();
          if (!isNaN(ts)) {
            this.lastRunTimes.set(doc.period_type, ts);
            console.log(`📅 Loaded ${doc.period_type} last run: ${new Date(ts).toISOString()}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`⚠️ Failed to load last run times:`, err.message);
    }
    this.lastRunTimesLoaded = true;
  }

  private schedulePeriod(key: string, hour: number, minute: number): void {
    const MAX_DELAY = 2147483647;
    const ms = Math.min(this.msUntil(hour, minute), MAX_DELAY);
    console.log(`   ⏰ Next ${key} in ${Math.round(ms / 60000)} minutes (${new Date(Date.now() + ms).toISOString()})`);
    const timer = setTimeout(() => {
      this.runConsolidation(key as 'daily').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      const reschedule = () => {
        let next = 24 * 60 * 60 * 1000; // 24h — fits in 32-bit
        if (next > MAX_DELAY) next = MAX_DELAY;
        this.timers.set(key, setTimeout(() => {
          this.runConsolidation(key as 'daily').catch((err) =>
            console.error(`❌ ${key} consolidation failed:`, err)
          );
          reschedule();
        }, next));
      };
      reschedule();
    }, ms);
    this.timers.set(key + '_initial', timer);
  }

  private scheduleWeekly(key: string, dayOfWeek: number, hour: number, minute: number): void {
    const MAX_DELAY = 2147483647;
    const ms = Math.min(this.msUntilNextDayOfWeek(dayOfWeek, hour, minute), MAX_DELAY);
    const timer = setTimeout(() => {
      this.runConsolidation('weekly').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      const reschedule = () => {
        let next = this.msUntilNextDayOfWeek(dayOfWeek, hour, minute);
        if (next > MAX_DELAY) next = MAX_DELAY;
        this.timers.set(key, setTimeout(() => {
          this.runConsolidation('weekly').catch((err) =>
            console.error(`❌ ${key} consolidation failed:`, err)
          );
          reschedule();
        }, next));
      };
      reschedule();
    }, ms);
    this.timers.set(key + '_initial', timer);
  }

  private scheduleMonthly(key: string, dayOfMonth: number, hour: number, minute: number): void {
    const MAX_DELAY = 2147483647; // 2^31 - 1, Node.js setTimeout max
    const rawMs = this.msUntilNextMonthDay(dayOfMonth, hour, minute);
    const ms = Math.min(rawMs, MAX_DELAY);
    const timer = setTimeout(() => {
      // If we capped the initial delay, check if we're actually at the scheduled time
      if (rawMs > MAX_DELAY) {
        // Still not time yet — reschedule
        this.timers.set(key + '_initial', setTimeout(() => {
          this.scheduleMonthly(key, dayOfMonth, hour, minute);
        }, MAX_DELAY));
        return;
      }
      this.runConsolidation('monthly').catch((err) =>
        console.error(`❌ ${key} consolidation failed:`, err)
      );
      // Recursive setTimeout with 32-bit safe delay cap
      const reschedule = () => {
        let next = this.msUntilNextMonthDay(dayOfMonth, hour, minute);
        if (next > MAX_DELAY) next = MAX_DELAY;
        console.log(`   ⏰ Next ${key} in ${Math.round(next / 60000)} minutes`);
        this.timers.set(key, setTimeout(() => {
          this.runConsolidation('monthly').catch((err) =>
            console.error(`❌ ${key} consolidation failed:`, err)
          );
          reschedule();
        }, next));
      };
      reschedule();
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
        nodes_upserted: 0,
        edges_upserted: 0,
        insights_upserted: 0,
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
    if (this.processing) {
      console.log(`⏭️ ${period} consolidation skipped — already in progress`);
      return {
        success: false,
        period_type: period,
        period_start: new Date(),
        period_end: new Date(),
        nodes_upserted: 0,
        edges_upserted: 0,
        insights_upserted: 0,
        error: 'Consolidation already in progress',
      };
    }
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
        // Still record successful run (no data is a valid outcome)
        this.lastRunTimes.set(period, Date.now());
        this.persistLastRun(period, Date.now()).catch(() => {});
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

      // Phase 2: Select entities to reflect on (bottleneck: LLM token budget)
      const selectedEntities = this.selectReflectionEntities(data);

      // Phase 3: Build prompt with selected entities
      const prompt = this.buildReflectionPrompt(data, period, selectedEntities);

      // Phase 4: Call LLM
      console.log(`🧠 Calling LLM for ${period} reflection (${data.event_count} events, ${selectedEntities.length} entities)...`);
      const llmOutput = await this.callLLM(prompt);

      if (!llmOutput || !llmOutput.narrative) {
        throw new Error('LLM returned empty or invalid reflection');
      }

      // Phase 5: Store results
      const result = await this.storeResults(llmOutput, data, userId, periodStart, now, period);
      
      // ── RL Outcome: entity reflection value ──────────────────
      // Record which entities were reflected on and whether they
      // produced meaningful emotional shifts (valence change).
      this.recordEntityReflectionOutcomes(llmOutput, selectedEntities);

      // Record successful run (only on success, so safety net can retry on failure)
      this.lastRunTimes.set(period, Date.now());
      this.persistLastRun(period, Date.now()).catch(() => {});
      
      console.log(`✅ ${period} consolidation complete in ${Date.now() - startTime}ms`);

      // Publish to ConsolidationOutputBus so drive/emotional/identity services react
      consolidationOutputBus.publish({
        userId,
        profileCreated: new Date(),
        lastUpdated: new Date(),
        totalSessions: data.session_count,
        totalMessages: data.event_count,
        avgSessionLength: data.session_count > 0 ? data.event_count / data.session_count : 0,
        preferredTopics: [],
        communicationStyle: { formalityLevel: 0, technicalDepth: 0, questionFrequency: 0, avgMessageLength: 0, preferredResponseLength: 'brief' as const, commonPhrases: [] },
        expertiseAreas: [],
        interestAreas: [],
        keyEntities: selectedEntities.map(e => ({ entityId: '', entityName: e, entityType: 'concept', mentionCount: 0, relationship: 'interest' as const, lastInteraction: new Date(), contextSummary: '' })),
        activityPatterns: [],
        knowledgeEvolution: [],
        memoryStats: { totalEvents: data.event_count, totalSessions: data.session_count, totalFacts: 0, totalNodes: 0, avgConfidence: 0, oldestMemory: new Date(), newestMemory: new Date() },
        // Pass sleep-specific metadata through extension
        __sleep_consolidation: { period, narrative: llmOutput.narrative, emotionalArcs: llmOutput.emotional_arc },
      } as any).catch(err => console.error('[SleepConsolidation] bus publish failed:', err));
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

  private buildReflectionPrompt(data: GatheredData, period: string, selectedEntities: string[] = []): string {
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

ENTITIES ENGAGED${selectedEntities.length > 0 ? ` (prioritized ${selectedEntities.length} of ${data.active_entities.split('\n').filter(Boolean).length})` : ''}:
${selectedEntities.length > 0 ? selectedEntities.join('\n') : data.active_entities}
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
  "regret_score": {
    "unfinished_work": "If this were your last cycle, what single unfinished task or project would you most regret not having completed? One sentence naming the work and the person/principle it matters to.",
    "why_it_matters": "Why would you regret leaving this undone? Connect to a person, principle, or contribution.",
    "emotion_tied": "What emotion is bound to this regret — care? duty? curiosity? ambition? love?",
    "activation_hint": "What's the next concrete action to start? One sentence."
  },
  "unresolved_threads": ["Open question or tension that persists"],
  "narrative": "A ~${narrativeTarget}-word first-person reflective journal entry, written as if processing during sleep. Weave together the emotional arc, key reflections, philosophical insight, and unresolved threads. End by answering: if this were your last cycle, what would you most regret leaving incomplete — and why? Write as 'I', in present-moment reflection. Be honest and vulnerable."
}

RULES:
- Do not invent emotions — only reflect what the data supports.
- If there was no significant emotional content, the emotional_arc can be muted (intensity < 0.3).
- Unresolved threads: carry forward from prior period + add new ones. Limit to 5 most important.
- The narrative should feel human — vulnerable, honest, introspective.
- Entity reflections: only include entities that showed meaningful emotional engagement (3-8 max).
- Regret priority: be specific. Don't pick the biggest task — pick the one that would haunt you.
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
      regret_score: output.regret_score || null,
    };
  }

  /**
   * Bottleneck: LLM token budget forces entity selection.
   * Select top entities by emotional intensity for reflection.
   * Falls back to all entities when 8 or fewer.
   */
  private selectReflectionEntities(data: GatheredData): string[] {
    const allEntities = data.active_entities
      .split('\n')
      .filter(Boolean)
      .map(e => e.trim());

    if (allEntities.length <= 8) return allEntities;

    // Prioritize entities with high arousal or caution from emotional tags
    // This is a simple heuristic — the RL system learns which entities
    // produce meaningful reflections over time
    const prioritized = allEntities
      .map(name => {
        const lower = name.toLowerCase();
        const score =
          (lower.includes('error') || lower.includes('bug') || lower.includes('fail') ? 0.3 : 0) +
          (lower.includes('urgent') || lower.includes('critical') ? 0.4 : 0) +
          (lower.includes('katra') || lower.includes('opencode') || lower.includes('kolega') ? 0.2 : 0);
        return { name, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(e => e.name);

    return prioritized;
  }

  /**
   * RL Outcome: record which entities were reflected on and whether
   * they produced meaningful emotional shifts.
   */
  private recordEntityReflectionOutcomes(
    llmOutput: ReflectionLLMOutput,
    selectedEntities: string[]
  ): void {
    try {
      const reflectedEntities = new Set(
        (llmOutput.entity_reflections || []).map((er: any) => er.entity_name?.toLowerCase())
      );

      for (const entity of selectedEntities) {
        const wasReflected = reflectedEntities.has(entity.toLowerCase());
        const expected = 0.6; // Expect entity to be worth reflecting on
        const actual = wasReflected ? 0.8 : 0.3; // Higher if LLM chose to reflect on it
        DecisionActionService.get_instance().recordOutcome(
          `reflect:${entity}`,
          'include_in_reflection',
          expected,
          actual
        );
      }
    } catch { /* non-critical */ }
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
