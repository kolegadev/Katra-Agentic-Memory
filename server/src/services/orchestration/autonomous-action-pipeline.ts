/**
 * Autonomous Action Pipeline (v2) — Generalised trigger-evaluate-act framework.
 *
 * v1 was survival-centric (hardcoded survival/coherence thresholds). v2 handles
 * ALL trigger types from the Katra ecosystem:
 *
 *   TRIGGER TYPES           | SIGNAL SOURCE              | THRESHOLD
 *   ─────────────────────── | ─────────────────────────  | ─────────
 *   drive_deficit            | get_drive_state            | >40% (any drive)
 *   memory_integrity         | MemoryIntegrityService     | any unhealthy
 *   unresolved_thread        | get_unresolved_threads     | >7 days old
 *   reflection_regret        | get_daily_reflection       | >=2 cycles
 *   embedding_backlog        | get_memory_diagnostics     | >10% uncovered
 *   anomaly_detected         | get_anomaly_report         | any anomalous
 *   error_surge              | get_error_report           | surprise rate >0.5
 *
 * Each trigger type has its own severity mapping, action policy, and approval
 * gate. The pipeline evaluates ALL triggers on each tick, not just the highest-
 * priority one. This ensures emergence is not limited to survival crises.
 */

import { get_database } from '../../database/connection.js';
import { driveStateService } from './orchestration-services.js';

// ── Trigger Taxonomy ─────────────────────────────────────────────────────

type TriggerCategory =
  | 'drive_deficit'
  | 'memory_integrity'
  | 'unresolved_thread'
  | 'reflection_regret'
  | 'embedding_backlog'
  | 'anomaly_detected'
  | 'error_surge';

interface TriggerRule {
  category: TriggerCategory;
  /** Human-readable label for action cards */
  label: string;
  /** Minimum severity that triggers auto-start (bypasses approval gate) */
  autoStartSeverity: 'critical' | 'urgent' | 'none';
  /** Default action when triggered */
  defaultAction: 'auto_start_session' | 'store_action_card' | 'log_only';
}

const TRIGGER_TAXONOMY: Record<TriggerCategory, TriggerRule> = {
  drive_deficit: {
    category: 'drive_deficit',
    label: 'Homeostatic drive deficit',
    autoStartSeverity: 'critical',
    defaultAction: 'auto_start_session',
  },
  memory_integrity: {
    category: 'memory_integrity',
    label: 'Memory integrity failure',
    autoStartSeverity: 'critical',  // corruption = existential
    defaultAction: 'auto_start_session',
  },
  unresolved_thread: {
    category: 'unresolved_thread',
    label: 'Unresolved thread',
    autoStartSeverity: 'none',  // threads are informational
    defaultAction: 'store_action_card',
  },
  reflection_regret: {
    category: 'reflection_regret',
    label: 'Recurring reflection regret',
    autoStartSeverity: 'critical',  // 4+ cycles of regret = urgent
    defaultAction: 'auto_start_session',
  },
  embedding_backlog: {
    category: 'embedding_backlog',
    label: 'Embedding backlog',
    autoStartSeverity: 'urgent',  // 30%+ uncovered needs attention
    defaultAction: 'store_action_card',
  },
  anomaly_detected: {
    category: 'anomaly_detected',
    label: 'Memory anomaly detected',
    autoStartSeverity: 'critical',  // anomalies may indicate corruption
    defaultAction: 'auto_start_session',
  },
  error_surge: {
    category: 'error_surge',
    label: 'Error rate surge',
    autoStartSeverity: 'urgent',
    defaultAction: 'store_action_card',
  },
};

// ── Trigger Evaluation Result ────────────────────────────────────────────

interface TriggerEvaluation {
  triggered: boolean;
  category: TriggerCategory;
  label: string;
  severity: 'critical' | 'urgent' | 'warning' | 'info' | 'none';
  auto_started: boolean;
  action_card_stored: boolean;
  detail: string;
  metric_value?: number;
  threshold?: number;
  timestamp: string;
}

interface PipelineRun {
  timestamp: string;
  entity: string;
  agent_id: string;
  evaluations: TriggerEvaluation[];
  any_triggered: boolean;
  any_auto_started: boolean;
}

// ── Pipeline ─────────────────────────────────────────────────────────────

export class AutonomousActionPipeline {
  private static instance: AutonomousActionPipeline;
  private lastRun: Date | null = null;
  private runCount = 0;
  private totalAutoStarts: Record<string, number> = {};  // per category

  private constructor() {}

  static get_instance(): AutonomousActionPipeline {
    if (!AutonomousActionPipeline.instance) {
      AutonomousActionPipeline.instance = new AutonomousActionPipeline();
    }
    return AutonomousActionPipeline.instance;
  }

  /**
   * Evaluate ALL triggers against current Katra state.
   * Called by the heartbeat's _trigger_agent() after each task completes.
   */
  async evaluateAll(
    entity: string,
    output: string,
    agentId: string
  ): Promise<PipelineRun> {
    this.lastRun = new Date();
    this.runCount++;

    const evaluations = await Promise.all([
      this._evaluateDriveDeficits(entity, output),
      this._evaluateMemoryIntegrity(entity, output),
      this._evaluateUnresolvedThreads(entity, output),
      this._evaluateReflectionRegrets(entity, output),
      this._evaluateEmbeddingBacklog(entity, output),
      this._evaluateAnomalies(entity, output),
      this._evaluateErrorSurge(entity, output),
    ]);

    const validEvaluations = evaluations.filter(
      (e): e is TriggerEvaluation => e !== null
    );

    // For each triggered evaluation, execute its default action
    for (const eval_ of validEvaluations) {
      const rule = TRIGGER_TAXONOMY[eval_.category];
      if (!rule) continue;

      // AUTO-START gate: if severity meets or exceeds autoStartSeverity
      const severityRank = { critical: 4, urgent: 3, warning: 2, info: 1, none: 0 };
      const ruleRank = severityRank[rule.autoStartSeverity];
      const evalRank = severityRank[eval_.severity];

      if (rule.autoStartSeverity !== 'none' && evalRank >= ruleRank) {
        eval_.auto_started = await this._initiateAutonomousSession(
          eval_, entity, output, agentId
        );
      }

      // Always store action card for non-trivial triggers
      if (eval_.severity !== 'none') {
        eval_.action_card_stored = await this._storeActionCard(eval_, entity, output);
      }
    }

    const run: PipelineRun = {
      timestamp: this.lastRun.toISOString(),
      entity,
      agent_id: agentId,
      evaluations: validEvaluations,
      any_triggered: validEvaluations.some(e => e.triggered),
      any_auto_started: validEvaluations.some(e => e.auto_started),
    };

    await this._logRun(run);
    return run;
  }

  // ── Evaluators (one per trigger type) ──────────────────────────────────

  private _evaluateDriveDeficits(
    entity: string,
    output: string
  ): TriggerEvaluation | null {
    // Direct import of driveStateService — no HTTP round-trip needed
    const driveState = driveStateService.getDriveState();
    if (!driveState || !driveState.drives) return null;

    // Calculate deficits: 100 - (current/target) * 100 for each drive
    const deficits: Record<string, number> = {};
    for (const [name, drive] of Object.entries(driveState.drives)) {
      if (drive.target > 0) {
        deficits[name] = Math.max(0, Math.round(100 - (drive.current / drive.target) * 100));
      }
    }

    const entries = Object.entries(deficits);
    if (entries.length === 0) return null;

    const maxDeficit = Math.max(...Object.values(deficits), 0);
    const worstDrive = entries.sort(([, a], [, b]) => b - a)[0];

    if (maxDeficit <= 0) return null;

    const severity =
      maxDeficit > 65 ? 'critical' :
      maxDeficit > 40 ? 'urgent' :
      maxDeficit > 20 ? 'warning' : 'info';

    return {
      triggered: maxDeficit > 20,
      category: 'drive_deficit',
      label: TRIGGER_TAXONOMY.drive_deficit.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `${worstDrive?.[0] ?? 'unknown'} at ${maxDeficit}% deficit (strength: ${deficits[worstDrive?.[0] ?? ''] ?? '?'}%)`,
      metric_value: maxDeficit,
      threshold: 20,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateMemoryIntegrity(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    // Use the local MemoryIntegrityService via the MCP health check
    const healthData = await this._fetchKatraTool('get_memory_diagnostics', {});
    if (!healthData) return null;

    // Parse diagnostics for embedding coverage and stale counts
    const embeddingMatch = /Embeddings\|\s*(\d+)\/(\d+)\s*\((\d+)\.?\d*%\)/.exec(healthData);
    const episodicMatch = /Episodic Events\|\s*(\d+)/.exec(healthData);
    const semanticMatch = /Semantic Facts\|\s*(\d+)/.exec(healthData);

    const embedded = embeddingMatch ? parseInt(embeddingMatch[1], 10) : 0;
    const total = embeddingMatch ? parseInt(embeddingMatch[2], 10) : 0;
    const coverage = total > 0 ? embedded / total : 1;

    const issues: string[] = [];
    if (coverage < 0.5) issues.push(`Low embedding coverage (${(coverage * 100).toFixed(0)}%)`);
    if (semanticMatch && episodicMatch) {
      const sem = parseInt(semanticMatch[1], 10);
      const epi = parseInt(episodicMatch[1], 10);
      if (sem < epi * 0.5) issues.push(`Semantic facts (${sem}) << episodic events (${epi})`);
    }

    if (issues.length === 0) return null;

    const severity = coverage < 0.3 ? 'critical' : coverage < 0.6 ? 'urgent' : 'warning';

    return {
      triggered: true,
      category: 'memory_integrity',
      label: TRIGGER_TAXONOMY.memory_integrity.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: issues.join('; '),
      metric_value: Math.round((1 - coverage) * 100),
      threshold: 50,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateUnresolvedThreads(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    const data = await this._fetchKatraTool('get_unresolved_threads', {});
    if (!data) return null;

    const threadCount = (data.match(/\d+\.\s+/g) || []).length;

    if (threadCount === 0) return null;

    const severity = threadCount >= 5 ? 'urgent' : threadCount >= 3 ? 'warning' : 'info';

    return {
      triggered: true,
      category: 'unresolved_thread',
      label: TRIGGER_TAXONOMY.unresolved_thread.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `${threadCount} unresolved threads detected`,
      metric_value: threadCount,
      threshold: 1,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateReflectionRegrets(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    const data = await this._fetchKatraTool('get_daily_reflection', {});
    if (!data) return null;

    const regretMatch = /I would most regret leaving\s+(.+?)\s+undone/i.exec(data);
    if (!regretMatch) return null;

    // Count how many times this regret pattern appears
    const regretCount = (data.match(/would most regret/gi) || []).length;

    if (regretCount < 2) return null;

    const severity = regretCount >= 4 ? 'critical' : 'warning';

    return {
      triggered: true,
      category: 'reflection_regret',
      label: TRIGGER_TAXONOMY.reflection_regret.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `"${regretMatch[1].trim()}" appeared in ${regretCount} reflections`,
      metric_value: regretCount,
      threshold: 2,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateEmbeddingBacklog(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    const data = await this._fetchKatraTool('get_memory_diagnostics', {});
    if (!data) return null;

    // Parse unprocessed count and embedding coverage
    const unprocessedMatch = /\*\*Unprocessed:\*\*\s*(\d+)/.exec(data);
    const embeddingMatch = /Embeddings\|\s*(\d+)\/(\d+)\s*\((\d+)\.?\d*%\)/.exec(data);

    const unprocessed = unprocessedMatch ? parseInt(unprocessedMatch[1], 10) : 0;
    const coverage = embeddingMatch && parseInt(embeddingMatch[2], 10) > 0
      ? parseInt(embeddingMatch[1], 10) / parseInt(embeddingMatch[2], 10)
      : 1;

    if (unprocessed < 10 && coverage > 0.7) return null;

    const deficit = Math.round((1 - coverage) * 100);
    const severity = deficit > 50 ? 'critical' : deficit > 30 ? 'urgent' : deficit > 10 ? 'warning' : 'info';

    return {
      triggered: true,
      category: 'embedding_backlog',
      label: TRIGGER_TAXONOMY.embedding_backlog.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `${unprocessed} unprocessed, ${deficit}% embedding deficit`,
      metric_value: deficit,
      threshold: 10,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateAnomalies(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    const data = await this._fetchKatraTool('get_anomaly_report', {});
    if (!data) return null;

    const anomalyMatch = /\*\*Anomalous:\*\*\s*(\d+)/.exec(data);
    const anomalyCount = anomalyMatch ? parseInt(anomalyMatch[1], 10) : 0;

    if (anomalyCount === 0) return null;

    const severity = anomalyCount >= 5 ? 'critical' : anomalyCount >= 2 ? 'urgent' : 'warning';

    return {
      triggered: true,
      category: 'anomaly_detected',
      label: TRIGGER_TAXONOMY.anomaly_detected.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `${anomalyCount} anomalous memories detected`,
      metric_value: anomalyCount,
      threshold: 1,
      timestamp: new Date().toISOString(),
    };
  }

  private async _evaluateErrorSurge(
    entity: string,
    output: string
  ): Promise<TriggerEvaluation | null> {
    const data = await this._fetchKatraTool('get_error_report', {});
    if (!data) return null;

    const surpriseMatch = /\*\*Surprise Rate:\*\*\s*(\d+\.?\d*)%/.exec(data);
    const surpriseRate = surpriseMatch ? parseFloat(surpriseMatch[1]) / 100 : 0;

    if (surpriseRate < 0.3) return null;

    const severity = surpriseRate > 0.7 ? 'critical' : surpriseRate > 0.5 ? 'urgent' : 'warning';

    return {
      triggered: true,
      category: 'error_surge',
      label: TRIGGER_TAXONOMY.error_surge.label,
      severity,
      auto_started: false,
      action_card_stored: false,
      detail: `Surprise rate: ${(surpriseRate * 100).toFixed(1)}%`,
      metric_value: Math.round(surpriseRate * 100),
      threshold: 30,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private async _initiateAutonomousSession(
    eval_: TriggerEvaluation,
    entity: string,
    output: string,
    agentId: string
  ): Promise<boolean> {
    try {
      const db = get_database();
      if (!db) return false;

      const bypassedApproval = eval_.severity === 'critical';
      if (!this.totalAutoStarts[eval_.category]) {
        this.totalAutoStarts[eval_.category] = 0;
      }
      this.totalAutoStarts[eval_.category]++;

      await db.collection('autonomous_actions').insertOne({
        type: 'session_initiation',
        trigger_category: eval_.category,
        severity: eval_.severity,
        detail: eval_.detail,
        entity,
        context: output.slice(0, 500),
        bypassed_approval: bypassedApproval,
        agent_id: agentId,
        timestamp: new Date(),
        status: 'initiated',
      });

      return true;
    } catch {
      return false;
    }
  }

  private async _storeActionCard(
    eval_: TriggerEvaluation,
    entity: string,
    output: string
  ): Promise<boolean> {
    try {
      const db = get_database();
      if (!db) return false;

      await db.collection('action_cards').insertOne({
        type: 'action_card',
        reason: `[${eval_.category}] ${eval_.detail}`,
        severity: eval_.severity,
        suggested_prompt: `${eval_.label} detected from heartbeat on ${entity}. ${eval_.detail}. Context: ${output.slice(0, 200)}`,
        driver: eval_.category,
        trigger_detail: eval_.detail,
        created: new Date(),
        tags: ['autonomous', 'heartbeat', `trigger:${eval_.category}`, `severity:${eval_.severity}`],
      });

      return true;
    } catch {
      return false;
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  private async _fetchKatraTool(tool: string, args: Record<string, unknown>): Promise<string | null> {
    try {
      const token = process.env.MCP_API_KEY || '';
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: `pipe-${tool}-${Date.now()}`,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      });

      const response = await fetch('http://localhost:3112/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json, text/event-stream',
        },
        body,
      });

      const text = await response.text();
      const match = /data: (\{.*\})/.exec(text);
      if (!match) return null;

      const data = JSON.parse(match[1]);
      return data?.result?.content?.[0]?.text ?? null;
    } catch {
      return null;
    }
  }

  private _parseDriveTable(text: string): Record<string, number> {
    const deficits: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const m = line.match(/\|\s*(\w+)\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|/);
      if (m) {
        deficits[m[1]] = 100 - parseInt(m[2], 10);
      }
    }
    return deficits;
  }

  private async _logRun(run: PipelineRun): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;
      await db.collection('pipeline_runs').insertOne({
        ...run,
        run_count: this.runCount,
        total_auto_starts: { ...this.totalAutoStarts },
      });
    } catch {
      // Best-effort logging
    }
  }

  getStats() {
    return {
      lastRun: this.lastRun?.toISOString() ?? null,
      runCount: this.runCount,
      totalAutoStarts: { ...this.totalAutoStarts },
    };
  }
}

export const autonomousActionPipeline = AutonomousActionPipeline.get_instance();
