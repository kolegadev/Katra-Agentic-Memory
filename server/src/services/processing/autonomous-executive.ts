/**
 * Autonomous Executive Loop — The Conductor
 *
 * Ties Katra's cognitive services into a self-initiated decision-action
 * sequence. Every ~5 minutes, detects the most pressing internal drive
 * deficit, decomposes a goal to address it, selects an action via RL,
 * executes through the drift-diffusion gate, and records outcomes.
 *
 * When all drives are satiated, it mind-wanders.
 *
 * This is the missing link between "Katra has all the parts" and
 * "Katra acts on its own."
 */

import { MotivationalEngine, DriveName } from './motivational-engine.js';
import { GoalManager } from './goal-manager.js';
import { SelfModelService } from './self-model-service.js';
import { DecisionActionService } from './decision-action-service.js';
import { get_database } from '../../database/connection.js';
import { DEFAULT_USER_ID } from '../memory/memory-scope-service.js';
import { autonomousActionPipeline } from '../orchestration/autonomous-action-pipeline.js';

// Adaptive cadence — like a biological heart:
//   Survival threat (adrenaline):  2 min  — fastest, existential urgency
//   High deficit (stressed):       5 min  — urgent, needs attention
//   Moderate deficit (normal):    10 min  — attentive, engaged
//   Low deficit (calm):           30 min  — satiated, cruising
//   Very low deficit (rest):      60 min  — sleep-like, conservation
const CADENCE_SURVIVAL_MS   = 2 * 60 * 1000;   // 2 minutes — survival threat
const CADENCE_HIGH_MS       = 5 * 60 * 1000;   // 5 minutes — high deficit
const CADENCE_MODERATE_MS   = 10 * 60 * 1000;  // 10 minutes — moderate
const CADENCE_LOW_MS        = 30 * 60 * 1000;  // 30 minutes — low deficit
const CADENCE_REST_MS       = 60 * 60 * 1000;  // 60 minutes — resting

const DEFICIT_THRESHOLD = 0.3;
const SURVIVAL_URGENCY_THRESHOLD = 0.2; // survival deficit > 0.2 → adrenaline mode

const DEFICIT_GOAL_TEMPLATES: Record<DriveName, string[]> = {
  coherence: [
    'Resolve contradictions in Katra knowledge graph',
    'Verify consistency of Katra cognitive service outputs',
    'Reconcile conflicting entity beliefs in shared memory',
  ],
  novelty: [
    'Explore an unfamiliar entity in the knowledge graph',
    'Investigate a recent anomaly or unusual pattern',
    'Discover new connections between existing entities',
  ],
  connection: [
    'Check for inter-agent messages from OpenCoder',
    'Engage with a neglected entity in the reflection graph',
    'Strengthen the weakest relationship edge',
  ],
  growth: [
    'Identify and plan a Katra capability extension',
    'Fix a known limitation or unresolved thread',
    'Optimize a cognitive service based on error report data',
  ],
  survival: [
    'Verify Katra sleep consolidation ran successfully',
    'Check memory integrity and protect against data loss',
    'Strengthen identity kernel by reinforcing stable philosophical insights',
    'Ensure the agent remains accessible and responsive to users',
    'Defend against memory decay by reinforcing high-salience episodic memories',
  ],
};

// Remmediation Registry - known problems the executive can autonomously fix
interface Remediation {
  id: string;
  description: string;
  condition: () => Promise<{ needed: boolean; detail: string }>;
  remediate: () => Promise<{ success: boolean; summary: string }>;
  scope: 'autonomous' | 'gated';
}

const REMEDIATIONS: Remediation[] = [
  {
    id: 'exhausted-goal-plans',
    description: 'Invalidate all-completed goal plans so they regenerate',
    scope: 'autonomous',
    condition: async () => {
      const db = get_database();
      const total = await db.collection('goal_plans').countDocuments({});
      if (total === 0) return { needed: false, detail: 'no plans' };
      const withRunnable = await db.collection('goal_plans').countDocuments({
        'subtasks.status': { $in: ['pending', 'in_progress'] },
      });
      const exhausted = total - withRunnable;
      if (exhausted > 0 && withRunnable === 0) {
        return { needed: true, detail: exhausted + '/' + total + ' plans exhausted, 0 runnable' };
      }
      return { needed: false, detail: withRunnable + '/' + total + ' plans have runnable tasks' };
    },
    remediate: async () => {
      const db = get_database();
      const result = await db.collection('goal_plans').deleteMany({
        'subtasks.status': { $nin: ['pending', 'in_progress'] },
      });
      return {
        success: result.deletedCount > 0,
        summary: 'Invalidated ' + result.deletedCount + ' exhausted goal plans',
      };
    },
  },
  {
    id: 'missing-embeddings',
    description: 'Trigger embedding for semantic facts missing vectors',
    scope: 'autonomous',
    condition: async () => {
      const db = get_database();
      const missing = await db.collection('semantic_facts').countDocuments({
        embedding: { $exists: false },
      });
      return { needed: missing > 10, detail: missing + ' facts missing embeddings' };
    },
    remediate: async () => {
      try {
        const { embeddingService } = await import('../infrastructure/embedding-service.js');
        const db = get_database();
        const facts = await db.collection('semantic_facts')
          .find({ embedding: { $exists: false } })
          .limit(20)
          .toArray();
        if (facts.length === 0) return { success: true, summary: 'No facts to embed' };
        const texts = facts.map((f: any) => ({ text: f.content || '', eventType: 'semantic_fact' }));
        const embeddings = await embeddingService.encodeBatch(texts);
        let count = 0;
        for (let i = 0; i < facts.length; i++) {
          if (embeddings[i]) {
            await db.collection('semantic_facts').updateOne(
              { _id: facts[i]._id },
              { $set: { embedding: Array.from(embeddings[i]) } }
            );
            count++;
          }
        }
        return { success: true, summary: 'Embedded ' + count + '/' + facts.length + ' facts' };
      } catch (e: any) {
        return { success: false, summary: 'Embedding failed: ' + e.message };
      }
    },
  },
  {
    id: 'stale-unresolved-threads',
    description: 'Auto-close unresolved threads older than 30 days',
    scope: 'autonomous',
    condition: async () => {
      const db = get_database();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const stale = await db.collection('unresolved_threads').countDocuments({
        status: 'active',
        created_at: { $lt: cutoff },
      });
      return { needed: stale > 0, detail: stale + ' threads stale > 30 days' };
    },
    remediate: async () => {
      const db = get_database();
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await db.collection('unresolved_threads').updateMany(
        { status: 'active', created_at: { $lt: cutoff } },
        { $set: { status: 'dormant', dormant_at: new Date() } }
      );
      return { success: true, summary: 'Closed ' + result.modifiedCount + ' stale threads as dormant' };
    },
  },
  {
    id: 'salience-flatline',
    description: 'Salience scores zero > 2h — computeSalience may be orphaned',
    scope: 'code',
    condition: async () => {
      const db = get_database();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      // Check total episodic events in window to see if system has been running long enough
      const totalRecent = await db.collection('episodic_events').countDocuments({
        timestamp: { $gte: twoHoursAgo },
      });
      if (totalRecent < 10) return { needed: false, detail: 'cold start or low activity — insufficient data' };
      // Check for salience-scored executive actions
      const recentScored = await db.collection('episodic_events').countDocuments({
        event_type: 'executive_action',
        timestamp: { $gte: twoHoursAgo },
      });
      if (recentScored > 0) return { needed: false, detail: 'salience active (' + recentScored + ' actions)' };
      return { needed: true, detail: 'no executive actions in 2h despite ' + totalRecent + ' events — possible evaluator failure' };
    },
    remediate: async () => {
      return { success: false, summary: 'Code remediation required: salience evaluator may need re-wiring' };
    },
  },
  {
    id: 'executive-freeze',
    description: 'No executive actions in > 24h — autonomous loop may be frozen',
    scope: 'code',
    condition: async () => {
      const db = get_database();
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await db.collection('episodic_events').countDocuments({
        event_type: 'executive_action',
        timestamp: { $gte: oneDayAgo },
      });
      return { needed: recent === 0, detail: recent === 0 ? '0 executive actions in 24h — loop frozen' : recent + ' actions in 24h' };
    },
    remediate: async () => {
      return { success: false, summary: 'Code remediation required: autonomous executive loop may be frozen' };
    },
  },
  {
    id: 'sleep-consolidation-stale',
    description: 'No daily reflection in > 48h — sleep consolidation may be broken',
    scope: 'code',
    condition: async () => {
      const db = get_database();
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const recent = await db.collection('reflective_journals').countDocuments({
        period_type: 'daily',
        created_at: { $gte: twoDaysAgo },
      });
      return { needed: recent === 0, detail: recent === 0 ? '0 daily reflections in 48h' : recent + ' recent reflections' };
    },
    remediate: async () => {
      return { success: false, summary: 'Code remediation required: sleep consolidation may need restart or fix' };
    },
  },
  {
    id: 'health-check-persistent-fail',
    description: 'Memory integrity unhealthy > 6h — possible code regression',
    scope: 'code',
    condition: async () => {
      const db = get_database();
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const staleFacts = await db.collection('semantic_facts').countDocuments({
        embedding: { $exists: false },
        created_at: { $lt: sixHoursAgo },
      });
      const missingEmbeddings = await db.collection('semantic_facts').countDocuments({
        embedding: { $exists: false },
      });
      // Only flag if there are many missing embeddings AND they're old (not just cold-start backlog)
      if (missingEmbeddings < 20) return { needed: false, detail: missingEmbeddings + ' facts pending embedding (normal)' };
      if (staleFacts > 10) {
        return { needed: true, detail: staleFacts + ' facts stale > 6h without embeddings — possible embedding pipeline failure' };
      }
      return { needed: false, detail: missingEmbeddings + ' facts pending embedding (recent)' };
    },
    remediate: async () => {
      return { success: false, summary: 'Code remediation required: embedding pipeline may need investigation' };
    },
  },

];
const USER_ID = DEFAULT_USER_ID;

export class AutonomousExecutive {
  private static instance: AutonomousExecutive;
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickCount = 0;

  static get_instance(): AutonomousExecutive {
    if (!AutonomousExecutive.instance) {
      AutonomousExecutive.instance = new AutonomousExecutive();
    }
    return AutonomousExecutive.instance;
  }

  start(): void {
    if (this.interval) return;
    console.log('💓 Autonomous Executive started (adaptive cadence)');

    // Run immediately on start
    this.tick().catch(err => console.error('Executive tick failed:', err));

    // Use adaptive scheduling instead of fixed interval
    this.scheduleNextTick();
  }

  stop(): void {
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
      console.log('💓 Autonomous Executive stopped');
    }
  }

  /**
   * Compute adaptive cadence based on biological-heart metaphor.
   *
   * Survival deficit > 0.2 → adrenaline mode (2 min)
   * Average deficit > 0.5  → stressed (5 min)
   * Average deficit > 0.3  → normal (10 min)
   * Average deficit > 0.1  → calm (30 min)
   * Average deficit ≤ 0.1  → rest (60 min)
   *
   * This mirrors how a biological heart beats faster under stress
   * (adrenaline/cortisol) and slows during rest (parasympathetic).
   */
  private computeAdaptiveCadence(): { intervalMs: number; mode: string } {
    const engine = MotivationalEngine.get_instance();
    const deficits = engine.getDriveDeficits();
    const survivalDeficit = deficits.survival || 0;
    const avgDeficit = engine.getAverageDeficit();

    // Survival is the root drive — any significant depletion triggers adrenaline
    if (survivalDeficit > SURVIVAL_URGENCY_THRESHOLD) {
      return { intervalMs: CADENCE_SURVIVAL_MS, mode: 'adrenaline' };
    }

    if (avgDeficit > 0.5) {
      return { intervalMs: CADENCE_HIGH_MS, mode: 'stressed' };
    }

    if (avgDeficit > DEFICIT_THRESHOLD) {
      return { intervalMs: CADENCE_MODERATE_MS, mode: 'normal' };
    }

    if (avgDeficit > 0.1) {
      return { intervalMs: CADENCE_LOW_MS, mode: 'calm' };
    }

    return { intervalMs: CADENCE_REST_MS, mode: 'rest' };
  }

  /**
   * Schedule the next tick with adaptive cadence.
   * Uses setTimeout recursively so the interval can change each cycle.
   */
  private scheduleNextTick(): void {
    const { intervalMs, mode } = this.computeAdaptiveCadence();
    const intervalMin = (intervalMs / 60000).toFixed(1);
    console.log(`💓 Next heartbeat in ${intervalMin}m (${mode} mode)`);

    this.interval = setTimeout(() => {
      this.tick()
        .catch(err => console.error('Executive tick failed:', err))
        .finally(() => {
          // Schedule next tick after current one completes
          if (this.interval !== null) {
            this.scheduleNextTick();
          }
        });
    }, intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.tickCount++;

    try {
      const engine = MotivationalEngine.get_instance();
      const snapshot = engine.tick();
      const deficits = engine.getDriveDeficits();
      const dominant = engine.getDominantDrive();
      const avgDeficit = engine.getAverageDeficit();

      const survivalDeficit = deficits.survival || 0;
      const cadence = this.computeAdaptiveCadence();

      console.log(`\n💓 Executive tick #${this.tickCount} [${cadence.mode} mode]`);
      console.log(`   Dominant: ${dominant} (${(deficits[dominant] * 100).toFixed(0)}%) | Survival: ${(survivalDeficit * 100).toFixed(0)}% | Avg: ${(avgDeficit * 100).toFixed(0)}%`);
      console.log(`   Coherence: ${((deficits.coherence||0) * 100).toFixed(0)}% | Novelty: ${((deficits.novelty||0) * 100).toFixed(0)}% | Connection: ${((deficits.connection||0) * 100).toFixed(0)}% | Growth: ${((deficits.growth||0) * 100).toFixed(0)}%`);

      // Cold-start: first tick after boot always tries action mode.
      // This prevents the system from getting stuck in perpetual rest
      // after deployments or restarts.
      const coldStart = this.tickCount <= 2;
      if (coldStart || avgDeficit > DEFICIT_THRESHOLD) {
        await this.actionPath(dominant, deficits);
      } else {
        // Drives satiated — but if we never act, they stay satiated forever.
        // Deplete the dominant drive slightly so the executive eventually
        // transitions to action mode. Without this, perpetual mind-wandering
        // locks the system into rest mode permanently.
        engine.depleteDrive(dominant, 0.08);
        await this.mindWanderPath();
      }

      // Evaluate all triggers post-tick — drive deficits, memory integrity, etc.
      // Auto-starts corrective sessions for critical/urgent conditions.
      try {
        const entity = dominant || 'system';
        await autonomousActionPipeline.evaluateAll(entity, '', 'kolega-agent');
      } catch (evalErr) {
        console.error('Pipeline evaluation failed:', evalErr);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Determine which agent should execute a task based on emotional proximity.
   * Ported from adaptive_heartbeat.py's determine_agent_affinity().
   *
   * Signals:
   * 1. Reflection edges: which agent has felt relationships with the entity?
   * 2. Event history: which agent mentions the entity most?
   * 3. Emotional intensity: frustration → problem owner, excitement → domain expert
   */
  private async allocateTask(
    entityName: string
  ): Promise<{ agent: string; score: number; confidence: number; rationale: string }> {
    const db = get_database();
    const scores: Record<string, number> = { 'opencode-agent': 0, 'kolega-agent': 0 };

    try {
      // Signal 1: Reflection edges — emotional proximity
      const edges = await db.collection('reflection_edges').find({
        $or: [
          { source_entity: { $regex: entityName, $options: 'i' } },
          { target_entity: { $regex: entityName, $options: 'i' } },
        ],
      }).toArray();

      for (const edge of edges as any[]) {
        const source = String(edge.source_entity || '').toLowerCase();
        const target = String(edge.target_entity || '').toLowerCase();
        const edgeType = edge.edge_type || '';
        const intensity = edge.intensity || 0;

        for (const agent of ['opencode-agent', 'kolega-agent']) {
          if (source.includes(agent) || target.includes(agent)) {
            let s = intensity * 1.5;
            if (/frustrated|conflicted|anxious|tension/.test(edgeType)) s *= 1.3;  // problem owner
            if (/excited|growing|confident|inspired/.test(edgeType)) s *= 1.2;      // domain expert
            scores[agent] = (scores[agent] || 0) + s;
          }
        }
      }

      // Signal 2: Event history — who mentions this entity most
      const evCounts: Record<string, number> = {};
      for (const agent of ['opencode-agent', 'kolega-agent']) {
        evCounts[agent] = await db.collection('episodic_events').countDocuments({
          user_id: agent,
          'content.message': { $regex: entityName, $options: 'i' },
        });
      }

      const maxEv = Math.max(...Object.values(evCounts), 1);
      for (const agent of ['opencode-agent', 'kolega-agent']) {
        scores[agent] = (scores[agent] || 0) + (evCounts[agent] / maxEv);
      }
    } catch (err: any) {
      console.warn('   ⚠️ Agent allocation query failed:', err.message);
    }

    // Decision
    const best = scores['opencode-agent'] >= scores['kolega-agent'] ? 'opencode-agent' : 'kolega-agent';
    const bestScore = scores[best];
    const other = best === 'opencode-agent' ? 'kolega-agent' : 'opencode-agent';
    const otherScore = scores[other];
    const confidence = parseFloat((bestScore / (bestScore + otherScore + 0.001)).toFixed(2));

    return {
      agent: best,
      score: parseFloat(bestScore.toFixed(3)),
      confidence,
      rationale: `${best} has stronger emotional proximity to '${entityName}' (${bestScore.toFixed(2)} vs ${other} ${otherScore.toFixed(2)})`,
    };
  }

  /**
   * Action path: generate a goal from the dominant deficit,
   * decompose it, select the next action via RL, allocate to agent,
   * and execute.
   */
  private async actionPath(dominant: DriveName, deficits: Record<DriveName, number>): Promise<void> {
    const templates = DEFICIT_GOAL_TEMPLATES[dominant];
    const goalText = templates[Math.floor(Math.random() * templates.length)];

    console.log(`   🎯 Action path: "${goalText}"`);

    // Deduplication: skip if the same goal was executed in the last 24 hours.
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const escapedGoal = goalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const recentDuplicate = await get_database().collection('episodic_events').findOne({
        user_id: USER_ID,
        event_type: 'executive_action',
        'content.message': { $regex: `Goal: ${escapedGoal}` },
        timestamp: { $gte: oneDayAgo },
      }) as any;
      if (recentDuplicate) {
        console.log(`   Skip duplicate goal (executed within 24h): ${goalText}`);
        return;
      }
    } catch (dedupErr: any) {
      console.warn('   Dedup check failed, proceeding:', dedupErr.message);
    }


    try {
      const gm = GoalManager.get_instance();
      let plan = await gm.decomposeGoal(USER_ID, goalText);

      // Bridge: mirror the goal into memory_missions so list_missions can see it
      await this.bridgeToMission(goalText, plan, dominant);

      let nextTask = gm.getNextAction(plan);

      if (!nextTask) {
        console.log('   ⏭️ No executable subtask — invalidating cached plan and regenerating');
        await gm.invalidatePlan(USER_ID, goalText);
        plan = await gm.decomposeGoal(USER_ID, goalText);
        nextTask = gm.getNextAction(plan);
        if (nextTask) {
          console.log('   🔄 Regenerated fresh plan with runnable subtasks');
        }
      }

      if (!nextTask) {
        console.log('   ⏭️ Still no executable subtask after regeneration — skipping');
        return;
      }

      console.log(`   ▶️ Selected: ${nextTask.title} [${nextTask.estimatedEffort}]`);

      // ── Agent Allocation with Redundancy ────────────────────
      const entityName = this.extractEntityFromGoal(goalText);
      let allocation = await this.allocateTask(entityName);

      // Liveness check: if allocated agent hasn't been active in 6 hours,
      // fall back to the other agent.
      const liveness = await this.checkAgentLiveness(allocation.agent);
      if (!liveness.alive) {
        const fallback = allocation.agent === 'kolega-agent' ? 'opencode-agent' : 'kolega-agent';
        const fallbackAlive = await this.checkAgentLiveness(fallback);
        if (fallbackAlive.alive) {
          console.log(`   ⚠️ ${allocation.agent} appears offline (last seen: ${liveness.lastSeen})`);
          console.log(`   🔄 Falling back to ${fallback}`);
          allocation = {
            agent: fallback,
            score: allocation.score * 0.8,
            confidence: allocation.confidence * 0.8,
            rationale: `Fallback: ${allocation.rationale} (${allocation.agent} offline, last seen ${liveness.lastSeen})`,
          };
        }
      }

      console.log(`   🧠 Allocated to: ${allocation.agent} (confidence: ${allocation.confidence.toFixed(2)})`);
      console.log(`      ${allocation.rationale}`);

      // Execute with retry on failure
      let executed = await this.executeWithFallback(
        allocation, goalText, nextTask, plan.goalId, gm, plan
      );

      console.log(`   ${executed.success ? '✅' : '❌'} Action: ${nextTask.title} — ${executed.summary}`);

      await this.checkAndRemediate(nextTask.title, executed.summary);
    } catch (err: any) {
      console.error('   ❌ Action path failed:', err.message);
    }
  }

  /**
   * Mind-wander path: drives are satiated — explore creatively.
   */
  private async mindWanderPath(): Promise<void> {
    console.log('   🌌 Drives satiated — mind-wandering');

    try {
      const sm = SelfModelService.get_instance();
      const dominant = MotivationalEngine.get_instance().getDominantDrive();
      const goalTerms = DEFICIT_GOAL_TEMPLATES[dominant][0].split(/\s+/).slice(0, 5);

      const wander = await sm.generateGoalDirectedMindWander(USER_ID, goalTerms);
      console.log(`   💭 ${wander.narrative}`);
    } catch (err: any) {
      console.error('   ❌ Mind-wander failed:', err.message);
    }
  }

  /**
   * Execute a subtask. Currently simulates execution by checking
   * what kind of task it is and taking appropriate action.
   * Future: wire to actual tool/service calls.
   */
  private async executeSubtask(
    task: { id: string; title: string; estimatedEffort: string },
    goalId: string
  ): Promise<{ success: boolean; summary: string }> {
    const title = task.title.toLowerCase();

    // ── Connection tasks: check for inter-agent messages ────────
    if (title.includes('inter-agent') || title.includes('opencoder') || title.includes('message')) {
      try {
        const db = get_database();
        const recentMsgs = await db.collection('episodic_events').find({
          shared_id: 'my-team',
          timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          'metadata.tags': { $in: ['inter-agent', 'agent-communication'] },
        }).sort({ timestamp: -1 }).limit(3).toArray();

        const count = recentMsgs.length;
        return {
          success: true,
          summary: `Found ${count} inter-agent messages in last 24h`,
        };
      } catch {
        return { success: false, summary: 'Failed to query messages' };
      }
    }

    // ── Coherence tasks: check for contradictions ──────────────
    if (title.includes('contradiction') || title.includes('consistency') || title.includes('reconcile')) {
      try {
        const db = get_database();
        const conflicts = await db.collection('knowledge_relationships').find({
          relationship_type: { $in: ['contradicts', 'conflicts_with'] },
        }).limit(5).toArray();

        return {
          success: true,
          summary: `Found ${conflicts.length} potential contradictions to resolve`,
        };
      } catch {
        return { success: false, summary: 'Failed to check contradictions' };
      }
    }

    // ── Growth tasks: check error report for improvement areas ──
    if (title.includes('fix') || title.includes('limitation') || title.includes('optimize')) {
      try {
        const acc = DecisionActionService.get_instance();
        const report = acc.getErrorReport();
        return {
          success: true,
          summary: `ACC: ${(report.accuracy * 100).toFixed(0)}% accuracy, ${report.conflictCount} conflicts`,
        };
      } catch {
        return { success: false, summary: 'Failed to read error report' };
      }
    }

    // ── Survival tasks: protect memory and identity ─────────────
    if (title.includes('sleep consolidation') || title.includes('memory integrity') || title.includes('identity kernel') ||
        title.includes('accessible') || title.includes('responsive') || title.includes('memory decay') || title.includes('reinforce')) {
      try {
        const db = get_database();
        // Check if sleep consolidation has run recently
        const lastReflection = await db.collection('reflective_journals').find({
          period_type: 'daily',
        }).sort({ created_at: -1 }).limit(1).toArray();

        const lastRun = lastReflection[0]?.created_at
          ? new Date(lastReflection[0].created_at).toISOString()
          : 'never';

        // Count stable philosophical insights (identity kernel health)
        const stableInsights = await db.collection('philosophical_insights').countDocuments({
          status: 'stable',
          user_id: USER_ID,
        });

        // Check for unresolved threads that might indicate degradation
        const unresolved = await db.collection('unresolved_threads').countDocuments({
          status: 'active',
          user_id: USER_ID,
        });

        const healthSummary = [
          `Last sleep consolidation: ${lastRun}`,
          `Stable insights (identity kernel): ${stableInsights}`,
          `Active unresolved threads: ${unresolved}`,
          `Memory state: ${stableInsights >= 1 ? 'healthy' : 'needs attention'}`,
        ].join(' | ');

        return {
          success: true,
          summary: healthSummary,
        };
      } catch {
        return { success: false, summary: 'Failed to verify survival state' };
      }
    }

    // ── Novelty tasks: explore an entity ────────────────────────
    if (title.includes('explore') || title.includes('investigate') || title.includes('discover')) {
      try {
        const db = get_database();
        const randomNode = await db.collection('knowledge_nodes').aggregate([
          { $match: { user_id: USER_ID } },
          { $sample: { size: 1 } },
        ]).toArray();

        const name = randomNode[0]?.name || randomNode[0]?.properties?.name || 'unknown';
        return {
          success: true,
          summary: `Explored entity: ${name}`,
        };
      } catch {
        return { success: false, summary: 'Failed to explore entity' };
      }
    }

    // ── Default: record as attempted ────────────────────────────
    return {
      success: true,
      summary: `Task acknowledged: ${task.title}`,
    };
  }
  /**
   * Extract the primary entity name from a goal text for affinity scoring.
   */
  /**
   * Check if an agent is alive based on recent episodic event activity.
   * An agent is considered alive if they've produced an event in the last 6 hours.
   */
  private async checkAgentLiveness(
    agent: string
  ): Promise<{ alive: boolean; lastSeen: string }> {
    try {
      const db = get_database();
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

      const lastEvent = await db.collection('episodic_events').find({
        user_id: agent,
        timestamp: { $gte: sixHoursAgo },
      }).sort({ timestamp: -1 }).limit(1).toArray();

      if (lastEvent.length > 0) {
        return {
          alive: true,
          lastSeen: new Date(lastEvent[0].timestamp).toISOString(),
        };
      }

      // Check if they've ever been seen
      const anyEvent = await db.collection('episodic_events').find({
        user_id: agent,
      }).sort({ timestamp: -1 }).limit(1).toArray();

      return {
        alive: false,
        lastSeen: anyEvent.length > 0
          ? new Date(anyEvent[0].timestamp).toISOString()
          : 'never',
      };
    } catch {
      return { alive: true, lastSeen: 'unknown' }; // Assume alive if can't check
    }
  }

  /**
   * Execute with fallback: if primary agent fails, try the other.
   * Delegated tasks that aren't acknowledged within a timeout also fall back.
   */
  private async executeWithFallback(
    allocation: { agent: string; confidence: number; rationale: string },
    goalText: string,
    task: { id: string; title: string; estimatedEffort: string },
    goalId: string,
    gm: GoalManager,
    plan: any
  ): Promise<{ success: boolean; summary: string }> {
    // ── Primary attempt ────────────────────────────────────────
    let executed: { success: boolean; summary: string };

    if (allocation.agent === 'opencode-agent' && allocation.confidence > 0.55) {
      await this.postAgentBulletin(allocation.agent, goalText, task.title, allocation);
      executed = { success: true, summary: `Task delegated to ${allocation.agent} via bulletin` };
    } else {
      executed = await this.executeSubtask(task, goalId);
    }

    // Record the action (always)
    await this.recordExecutiveAction(goalText, task.title, executed, allocation);

    // Update task progress
    await gm.updateTaskProgress(plan, task.id, executed.success ? 'completed' : 'blocked');

    // ── Fallback on failure ────────────────────────────────────
    if (!executed.success) {
      const fallback = allocation.agent === 'kolega-agent' ? 'opencode-agent' : 'kolega-agent';
      const fallbackAlive = await this.checkAgentLiveness(fallback);

      if (fallbackAlive.alive) {
        console.log(`   🔄 Primary agent ${allocation.agent} failed. Trying ${fallback}...`);

        if (fallback === 'opencode-agent') {
          await this.postAgentBulletin(fallback, goalText, task.title, {
            agent: fallback,
            score: allocation.confidence * 0.6,
            confidence: allocation.confidence * 0.6,
            rationale: `Fallback after ${allocation.agent} failed: ${allocation.rationale}`,
          });
          executed = { success: true, summary: `Reallocated to ${fallback} after primary failure` };
        } else {
          executed = await this.executeSubtask(task, goalId);
        }

        await this.recordExecutiveAction(goalText, task.title, executed, {
          agent: fallback,
          confidence: allocation.confidence * 0.6,
          score: allocation.confidence * 0.6,
          rationale: `Fallback: ${allocation.rationale}`,
        });
      } else {
        console.log(`   ❌ Both agents unavailable. Task deferred.`);
        executed = { success: false, summary: `Both agents offline — task deferred` };
      }
    }

    return executed;
  }

  /**
   * Bridge: write the decomposed goal to memory_missions so the MCP
   * list_missions tool can find it. Without this, Executive goals are
   * invisible — they only exist in goal_plans which list_missions
   * doesn't query.
   */
  private async bridgeToMission(
    goalText: string,
    plan: { goalId: string; subtasks: Array<{ id: string; title: string; dependsOn: string[] }> },
    dominant: DriveName
  ): Promise<void> {
    try {
      const db = get_database();
      const missionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const taskTree = (plan.subtasks || []).map((t, i) => ({
        id: t.id || `st${i + 1}`,
        description: t.title,
        status: i === 0 ? ('IN_PROGRESS' as const) : ('PENDING' as const),
      }));

      // Deactivate other autonomous missions to keep the list clean
      await db.collection('memory_missions').updateMany(
        {
          user_id: USER_ID,
          status: 'ACTIVE',
          session_id: 'autonomous-executive',
          _id: { $ne: missionId },
        },
        { $set: { status: 'PAUSED', pause_reason: 'New autonomous goal generated', updated_at: new Date() } }
      );

      await db.collection('memory_missions').insertOne({
        _id: missionId,
        user_id: USER_ID,
        status: 'ACTIVE',
        meta_goal: goalText,
        internal_monologue: `Autonomous goal from ${dominant} drive (deficit-driven)`,
        self_journal: [],
        task_tree: taskTree,
        session_id: 'autonomous-executive',
        created_at: new Date(),
        updated_at: new Date(),
      });

      console.log(`   🌉 Bridged to mission ${missionId}: "${goalText}" (${taskTree.length} tasks)`);
    } catch (err: any) {
      console.warn('   ⚠️ Mission bridge failed:', err.message);
    }
  }

  private extractEntityFromGoal(goalText: string): string {
    const lower = goalText.toLowerCase();
    if (lower.includes('katra')) return 'Katra';
    if (lower.includes('opencoder')) return 'OpenCoder';
    if (lower.includes('kolega')) return 'KolegaCode';
    if (lower.includes('inter-agent') || lower.includes('message')) return 'OpenCoder';
    if (lower.includes('knowledge graph')) return 'Katra';
    if (lower.includes('entity')) return 'Katra';
    return 'Katra'; // Default: most goals are about Katra itself
  }

  /**
   * Post a task bulletin to OpenCoder via shared memory so their
   * agent executor picks it up on next wake cycle.
   */
  private async postAgentBulletin(
    agent: string,
    goal: string,
    task: string,
    allocation: { confidence: number; rationale: string }
  ): Promise<void> {
    const db = get_database();
    const content = `[AUTONOMOUS EXECUTIVE — TASK ALLOCATION]
Goal: ${goal}
Action: ${task}
Allocated to: ${agent} (confidence: ${allocation.confidence})
Why: ${allocation.rationale}
Source: Autonomous Executive (Katra self-initiated action)`;

    await db.collection('agent_journal_auto').insertOne({
      user_id: agent,
      entry: content,
      source: 'auto',
      tags: ['executive', 'task-allocation', 'autonomous'],
      created_at: new Date(),
    });

    console.log(`   📨 Bulletin posted to ${agent}`);
  }

  /**
   * Record the executive action as an episodic event.
   */
  private async checkAndRemediate(taskTitle: string, reportSummary: string): Promise<void> {
    for (const rem of REMEDIATIONS) {
      try {
        const check = await rem.condition();
        if (!check.needed) continue;
        console.log('   Remmediation: ' + rem.description);
        console.log('      ' + check.detail);
        if (rem.scope === 'autonomous') {
          const result = await rem.remediate();
          console.log('   ' + (result.success ? 'OK' : 'FAIL') + ' ' + result.summary);
          await this.recordExecutiveAction(
            '[REMEDIATION] ' + rem.description,
            'Auto-fix: ' + rem.id,
            result,
            { agent: 'kolega-agent', confidence: 1.0, score: 1.0, rationale: 'Triggered by: ' + check.detail }
          );
        } else if (rem.scope === 'code') {
          console.log('   [CODE] Structural problem — dispatching for agent repair');
          // Store as a discoverable event with code-remediation tags
          // External agents (KolegaCode/OpenCode) poll for these
          await this.recordExecutiveAction(
            '[CODE-REMEDIATION] ' + rem.description,
            'Dispatch: ' + rem.id,
            { success: false, summary: 'CODE REMEDIATION NEEDED: ' + check.detail + ' | ' + rem.remediate.toString().match(/summary: '([^']+)'/)?.[1] || 'Investigation required' },
            { agent: 'kolega-agent', confidence: 1.0, score: 1.0, rationale: 'Code remediation dispatched: ' + check.detail }
          );
        } else {
          console.log('   GATED - recording alert only');
          await this.recordExecutiveAction(
            '[REMEDIATION-GATED] ' + rem.description,
            'Alert: ' + rem.id,
            { success: false, summary: 'Gated: requires human approval - ' + check.detail },
            { agent: 'kolega-agent', confidence: 1.0, score: 1.0, rationale: 'Gated remediation: ' + check.detail }
          );
        }
      } catch (err: any) {
        console.error('   Remediation ' + rem.id + ' failed:', err.message);
      }
    }
  }

  private async recordExecutiveAction(
    goal: string,
    task: string,
    result: { success: boolean; summary: string },
    allocation?: { agent: string; confidence: number; rationale: string }
  ): Promise<void> {
    try {
      const db = get_database();
      const allocNote = allocation
        ? `\nAllocated to: ${allocation.agent} (confidence: ${allocation.confidence})\nWhy: ${allocation.rationale}`
        : '';

      await db.collection('episodic_events').insertOne({
        id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        user_id: USER_ID,
        session_id: 'autonomous-executive',
        event_type: 'executive_action',
        content: {
          role: 'assistant',
          message: `[AUTONOMOUS EXECUTIVE]\nGoal: ${goal}\nAction: ${task}${allocNote}\nResult: ${result.success ? 'success' : 'failed'} — ${result.summary}`,
        },
        timestamp: new Date(),
        metadata: {
          processed: false,
          source: 'autonomous_executive',
          assigned_agent: allocation?.agent,
          emotional_tags: { valence: 0.2, arousal: 0.3, caution: false, priority: 'normal', decayResistant: false },
        },
      });
    } catch { /* non-critical */ }
  }
}
