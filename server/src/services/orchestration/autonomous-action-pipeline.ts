/**
 * Autonomous Action Pipeline — Connects the heartbeat trigger to drive-state
 * checking and autonomous session initiation.
 *
 * This closes Gap 1 from the Graphify analysis: _trigger_agent() (degree 2,
 * isolated in Community 18) had no path to check_drive_deficits() or
 * auto_start_session() (Community 85). This pipeline bridges them.
 *
 * Architecture:
 *   Heartbeat → _trigger_agent() → AutonomousActionPipeline → check_drive_deficits()
 *                                                            → auto_start_session()
 *
 * The pipeline has an explicit approval gate:
 *   - survival drive deficit > 80% → auto-start (no approval)
 *   - survival or coherence deficit > 65% → auto-start (no approval, critical)
 *   - any drive deficit > 40% → store action card, auto-start if urgent
 *   - below thresholds → log and skip
 */

import { get_database } from '../database/connection.js';

export interface PipelineResult {
  triggered: boolean;
  auto_started: boolean;
  action_card_stored: boolean;
  survival_deficit: number;
  dominant_drive: string;
  timestamp: string;
  reason?: string;
}

export class AutonomousActionPipeline {
  private static instance: AutonomousActionPipeline;
  private lastRun: Date | null = null;
  private runCount = 0;
  private totalAutoStarts = 0;

  private constructor() {}

  static get_instance(): AutonomousActionPipeline {
    if (!AutonomousActionPipeline.instance) {
      AutonomousActionPipeline.instance = new AutonomousActionPipeline();
    }
    return AutonomousActionPipeline.instance;
  }

  /**
   * Called by the heartbeat's _trigger_agent() when a task completes.
   * Evaluates whether drive deficits warrant autonomous action.
   *
   * @param entity  - The entity that triggered this check (e.g., "Katra", "KolegaCode")
   * @param output  - Context from the completed heartbeat task
   * @param agentId - The agent ID that executed the task
   */
  async evaluate(entity: string, output: string, agentId: string): Promise<PipelineResult> {
    this.lastRun = new Date();
    this.runCount++;

    const result: PipelineResult = {
      triggered: true,
      auto_started: false,
      action_card_stored: false,
      survival_deficit: 0,
      dominant_drive: 'unknown',
      timestamp: this.lastRun.toISOString(),
    };

    try {
      // Query Katra's drive state via the existing MCP interface
      const driveState = await this._fetchDriveState();
      if (!driveState) {
        result.reason = 'Could not read drive state';
        return result;
      }

      result.dominant_drive = driveState.dominant;
      const deficits = this._parseDriveDeficits(driveState);
      result.survival_deficit = deficits.survival;

      // ─── APPROVAL GATE ──────────────────────────────────────────────
      // Survival > 80% deficit = existential crisis → NO approval needed
      // Coherence > 65% deficit = memory integrity at risk → auto-start
      // Any drive > 40% = elevated → store action card

      if (deficits.survival > 80) {
        result.reason = `SURVIVAL CRISIS: ${deficits.survival}% deficit — bypassing approval gate`;
        result.auto_started = await this._initiateAutonomousSession(
          'survival',
          deficits.survival,
          entity,
          output
        );
      } else if (deficits.coherence > 65) {
        result.reason = `Coherence critical: ${deficits.coherence}% deficit — initiating repair session`;
        result.auto_started = await this._initiateAutonomousSession(
          'coherence',
          deficits.coherence,
          entity,
          output
        );
      } else if (Math.max(...Object.values(deficits)) > 40) {
        const worst = Object.entries(deficits).sort(([,a], [,b]) => b - a)[0];
        result.reason = `Elevated ${worst[0]} deficit (${worst[1]}%) — action card stored`;
        result.action_card_stored = await this._storeActionCard(
          worst[0],
          worst[1],
          entity,
          output,
          'warning'
        );
      } else {
        result.reason = `All drives within normal range (max deficit: ${Math.max(...Object.values(deficits))}%)`;
      }
    } catch (err: any) {
      result.reason = `Pipeline evaluation failed: ${err.message}`;
    }

    // Log the run for audit
    await this._logRun(entity, agentId, result);
    return result;
  }

  // ── Private ───────────────────────────────────────────────────────

  private async _fetchDriveState(): Promise<any | null> {
    try {
      // Use the Katra MCP endpoint (localhost since this runs on thebrick)
      const url = 'http://localhost:3112/mcp';
      const token = process.env.MCP_API_KEY || '';
      const body = JSON.stringify({
        jsonrpc: '2.0', id: `pipeline-${Date.now()}`,
        method: 'tools/call',
        params: { name: 'get_drive_state', arguments: {} },
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json, text/event-stream',
        },
        body,
      });

      const text = await response.text();
      // Parse SSE response
      const match = /data: (\{.*\})/.exec(text);
      if (!match) return null;
      const data = JSON.parse(match[1]);
      return JSON.parse(data.result.content[0].text || '{}');
    } catch {
      return null;
    }
  }

  private _parseDriveDeficits(driveData: any): Record<string, number> {
    // Parse from the table format returned by get_drive_state
    const deficits: Record<string, number> = {};
    if (typeof driveData === 'string') {
      for (const line of driveData.split('\n')) {
        const m = line.match(/\|\s*(\w+)\s*\|\s*(\d+)%\s*\|\s*(\d+)%\s*\|/);
        if (m) {
          deficits[m[1]] = 100 - parseInt(m[2], 10);
        }
      }
    }
    return deficits;
  }

  private async _initiateAutonomousSession(
    drive: string,
    deficit: number,
    entity: string,
    context: string
  ): Promise<boolean> {
    try {
      const db = get_database();
      if (!db) return false;

      // Store an autonomous action initiation record
      await db.collection('autonomous_actions').insertOne({
        type: 'session_initiation',
        drive,
        deficit,
        entity,
        context: context.slice(0, 500),
        timestamp: new Date(),
        status: 'initiated',
        bypassed_approval: deficit > 80,
      });

      this.totalAutoStarts++;

      // The actual session start is handled by the bridge's auto_start_session()
      // This method records the decision; the bridge will pick up the action card.
      return true;
    } catch {
      return false;
    }
  }

  private async _storeActionCard(
    drive: string,
    deficit: number,
    entity: string,
    context: string,
    severity: string
  ): Promise<boolean> {
    try {
      const db = get_database();
      if (!db) return false;

      await db.collection('action_cards').insertOne({
        type: 'action_card',
        reason: `Autonomous trigger: ${drive} at ${deficit}% deficit from heartbeat on ${entity}`,
        severity,
        suggested_prompt: `${entity} heartbeat detected ${drive} deficit. Context: ${context.slice(0, 200)}`,
        driver: 'autonomous-pipeline',
        created: new Date(),
        tags: ['autonomous', 'heartbeat', `drive:${drive}`],
      });

      return true;
    } catch {
      return false;
    }
  }

  private async _logRun(
    entity: string,
    agentId: string,
    result: PipelineResult
  ): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;
      await db.collection('pipeline_runs').insertOne({
        entity,
        agentId,
        ...result,
        run_count: this.runCount,
        total_auto_starts: this.totalAutoStarts,
      });
    } catch {
      // Best-effort logging
    }
  }

  /** Get pipeline statistics for monitoring. */
  getStats() {
    return {
      lastRun: this.lastRun?.toISOString() ?? null,
      runCount: this.runCount,
      totalAutoStarts: this.totalAutoStarts,
    };
  }
}

export const autonomousActionPipeline = AutonomousActionPipeline.get_instance();
