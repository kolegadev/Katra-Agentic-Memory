/**
 * Prospective Memory Service — Goal Tracking & Mission State
 *
 * Implements the fourth memory layer: persistent, structured goal trees
 * that let the agent track long-running missions across chat sessions.
 *
 * Schema: memory_missions collection
 *   - meta_goal: high-level mission description
 *   - internal_monologue: agent's self-reflection on current focus
 *   - task_tree: array of sub-tasks with status (PENDING/IN_PROGRESS/COMPLETED)
 *   - status: ACTIVE, PAUSED, COMPLETED, ABANDONED
 */

import { Db, ObjectId } from 'mongodb';
import { llmService } from '../infrastructure/llm-service.js';

export interface MissionTask {
  id: string;
  description: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';
}

export interface JournalEntry {
  timestamp: string;
  entry: string;
  source: 'manual' | 'auto' | 'correction';
  deprecated?: boolean;
  corrects_index?: number;  // index of the entry this corrects
  deprecated_by_index?: number;  // index of entry that deprecated this
}

export interface Mission {
  _id: string;
  user_id: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';
  meta_goal: string;
  internal_monologue: string;
  self_journal: (string | JournalEntry)[];  // mixed: legacy strings + new objects
  task_tree: MissionTask[];
  session_id?: string;
  pause_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface MissionUpdate {
  internal_monologue: string;
  task_updates: Array<{ id: string; status: MissionTask['status'] }>;
  new_tasks?: Array<{ description: string }>;
  mission_complete: boolean;
}

export interface AgentState {
  user_id: string;
  self_journal: JournalEntry[];  // manual personal entries (agent's diary)
  updated_at: Date;
}

export interface AutoJournalEntry {
  timestamp: string;
  entry: string;
  mission_id?: string;
  meta_goal?: string;
}

export interface HeartbeatJournalEntry {
  timestamp: string;
  entry: string;
  source: 'heartbeat';
  run_id?: string;
  task_name?: string;
}

export class ProspectiveMemoryService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Create a new mission from a chat command like "/mission build a weather app".
   * Auto-generates an initial task breakdown via DeepSeek.
   */
  public async createMission(
    user_id: string,
    meta_goal: string,
    session_id?: string
  ): Promise<Mission> {
    const missionId = `mission_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Ask DeepSeek to generate an initial task tree
    let task_tree: MissionTask[] = [];
    try {
      const breakdownPrompt = `Break down this goal into 3-6 concrete sequential sub-tasks:\n"${meta_goal}"\n\nReturn ONLY JSON: {"tasks":[{"description":"..."}]}`;
      const result = await llmService.extractJson(
        'Break down goals into sequential sub-tasks. Return ONLY JSON.',
        breakdownPrompt,
        800
      );
      const tasks: string[] = (result as any)?.tasks?.map((t: any) => t.description) || [];
      if (tasks.length === 0) {
        // Fallback: single task = the goal itself
        tasks.push(meta_goal);
      }
      task_tree = tasks.map((desc, i) => ({
        id: `t${i + 1}`,
        description: desc,
        status: i === 0 ? ('IN_PROGRESS' as const) : ('PENDING' as const),
      }));
    } catch {
      task_tree = [{
        id: 't1',
        description: meta_goal,
        status: 'IN_PROGRESS',
      }];
    }

    const mission: Mission = {
      _id: missionId,
      user_id,
      status: 'ACTIVE',
      meta_goal,
      internal_monologue: `Starting mission: ${meta_goal}. First step: ${task_tree[0]?.description || 'begin work'}.`,
      self_journal: [],
      task_tree,
      session_id,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Deactivate any other active missions (one at a time)
    await this.db.collection('memory_missions').updateMany(
      { user_id, status: 'ACTIVE', _id: { $ne: missionId } },
      { $set: { status: 'PAUSED', pause_reason: 'New mission started', updated_at: new Date() } }
    );

    await this.db.collection('memory_missions').insertOne(mission as any);
    console.log(`🎯 Mission created: ${missionId} — "${meta_goal}" (${task_tree.length} tasks)`);
    return mission;
  }

  /**
   * Get the currently active mission for a user.
   */
  public async getActiveMission(user_id: string): Promise<Mission | null> {
    return this.db.collection('memory_missions').findOne({
      user_id,
      status: 'ACTIVE',
    }) as Promise<Mission | null>;
  }

  /**
   * Get or create the agent's global state (journal, identity).
   * This persists across missions — it's the agent's personal memory.
   */
  public async getOrCreateAgentState(user_id: string): Promise<AgentState> {
    let state = await this.db.collection('agent_state').findOne({ user_id }) as AgentState | null;
    if (!state) {
      state = {
        user_id,
        self_journal: [],
        updated_at: new Date(),
      };
      await this.db.collection('agent_state').insertOne(state);
      console.log(`🆕 Agent state created for ${user_id}`);
    }
    return state;
  }

  /**
   * Get all missions for a user (for listing / history).
   */
  public async listMissions(user_id: string, limit: number = 10): Promise<Mission[]> {
    return this.db.collection('memory_missions')
      .find({ user_id })
      .sort({ updated_at: -1 })
      .limit(limit)
      .toArray() as Promise<Mission[]>;
  }

  /**
   * Manually update mission status (pause, resume, complete, abandon).
   */
  public async updateMissionStatus(
    missionId: string,
    status: Mission['status'],
    reason?: string
  ): Promise<void> {
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId },
      { $set: { status, pause_reason: reason, updated_at: new Date() } }
    );
    console.log(`🎯 Mission ${missionId} → ${status}${reason ? ` (${reason})` : ''}`);
  }

  /**
   * Reactivate a COMPLETED or ABANDONED mission (set back to ACTIVE).
   * Useful when a mission was prematurely marked complete or abandoned.
   */
  public async reactivateMission(missionId: string): Promise<Mission | null> {
    const result = await this.db.collection('memory_missions').findOneAndUpdate(
      { _id: missionId, status: { $in: ['COMPLETED', 'ABANDONED'] } },
      {
        $set: {
          status: 'ACTIVE',
          updated_at: new Date(),
          pause_reason: 'Reactivated by user',
        },
      },
      { returnDocument: 'after' }
    );
    if (result) {
      console.log(`🔄 Mission ${missionId} reactivated → ACTIVE`);
    }
    return result as Mission | null;
  }

  /**
   * Auto-expire missions that have been PAUSED for more than 72 hours.
   * Marks them ABANDONED with a journal note. Called periodically.
   * At 48h, adds a warning journal entry before the 72h cutoff.
   */
  public async autoExpireMissions(): Promise<number> {
    // First, warn missions paused > 48h but < 72h that auto-abandon is approaching
    const warnCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const expireCutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);

    // Expire missions paused > 72h
    const result = await this.db.collection('memory_missions').updateMany(
      {
        status: 'PAUSED',
        updated_at: { $lt: expireCutoff },
      },
      {
        $set: {
          status: 'ABANDONED',
          pause_reason: 'Auto-expired after 72h paused',
          updated_at: new Date(),
        },
      }
    );

    // Warn missions paused > 48h but not yet expired
    const warnResult = await this.db.collection('memory_missions').updateMany(
      {
        status: 'PAUSED',
        updated_at: { $lt: warnCutoff, $gte: expireCutoff },
        warned_expiring: { $ne: true },
      },
      {
        $set: { warned_expiring: true, updated_at: new Date() },
      }
    );
    if (result.modifiedCount > 0) {
      const abandoned = await this.db.collection('memory_missions')
        .find({ status: 'ABANDONED', 'self_journal.9': { $exists: false } })
        .limit(10)
        .toArray();

      for (const m of abandoned) {
        await this.db.collection('memory_missions').updateOne(
          { _id: m._id },
          {
            $push: {
              self_journal: {
                timestamp: new Date().toISOString(),
                entry: 'Mission auto-expired after 72 hours PAUSED',
                source: 'auto',
              } as any,
            },
          }
        );
      }

      console.log(`🕐 Auto-expired ${result.modifiedCount} missions paused > 72h`);
    }
    if (warnResult.modifiedCount > 0) {
      console.log(`⚠️ Warned ${warnResult.modifiedCount} missions paused > 48h (72h auto-abandon approaching)`);
    }
    return result.modifiedCount;
  }

  /**
   * Summarize a long text into a concise journal insight using DeepSeek.
   * Returns 1-2 sentences capturing the key takeaway.
   */
  public async summarizeForJournal(text: string): Promise<string> {
    const maxInput = 4000;
    const trimmed = text.length > maxInput ? text.slice(0, maxInput) + '\n...' : text;

    const systemPrompt = `You are a journal summarizer. Distill the user's message into 1-2 concise, insight-rich sentences that capture the key takeaway. Be specific but brief. Write in first person if the input is from an AI assistant reflecting on its own learning. Max 200 characters.`;

    try {
      const response = await llmService.extractJson(systemPrompt, trimmed, 300);
      if (response && typeof response.summary === 'string') {
        return response.summary.trim();
      }
      // Fallback: return first sentence if summarization fails
      return trimmed.split(/[.!?]/).filter(s => s.trim().length > 20)[0]?.trim() + '.' || trimmed.slice(0, 200);
    } catch (e) {
      console.warn('⚠️ Journal summarization failed, using fallback:', e);
      const firstSentence = trimmed.split(/[.!?]/).filter(s => s.trim().length > 20)[0]?.trim();
      return (firstSentence ? firstSentence + '.' : trimmed.slice(0, 200)).trim();
    }
  }

  /**
   * Summarize a batch of turns into a single journal insight using ONE LLM call.
   * Reduces token burn by batching up to 10 turns per call instead of one per turn.
   */
  public async summarizeForJournalBatch(text: string): Promise<string> {
    const maxInput = 6000;
    const trimmed = text.length > maxInput ? text.slice(0, maxInput) + '\n...' : text;

    const systemPrompt = `You are a journal summarizer. Below are multiple conversation turns between a user and an AI. Distill them into 2-3 concise, insight-rich sentences that capture the key themes, decisions, and outcomes. Be specific. Write in first person if the AI is reflecting on its own learning. Max 300 characters.`;

    try {
      const response = await llmService.extractJson(systemPrompt, trimmed, 400);
      if (response && typeof response.summary === 'string') {
        return response.summary.trim();
      }
      return trimmed.split(/[.!?]/).filter(s => s.trim().length > 20)[0]?.trim() + '.' || trimmed.slice(0, 300);
    } catch (e) {
      console.warn('⚠️ Batch journal summarization failed, using fallback:', e);
      const firstSentence = trimmed.split(/[.!?]/).filter(s => s.trim().length > 20)[0]?.trim();
      return (firstSentence ? firstSentence + '.' : trimmed.slice(0, 300)).trim();
    }
  }

  /**
   * Manually update a specific task's status.
   */
  public async updateTaskStatus(
    missionId: string,
    taskId: string,
    status: MissionTask['status']
  ): Promise<void> {
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId, 'task_tree.id': taskId },
      {
        $set: { 'task_tree.$.status': status, updated_at: new Date() },
      }
    );
  }

  /**
   * Append a manual journal entry to the agent's personal diary.
   * Uses structured JournalEntry format. Only called when goals_readwrite is enabled.
   */
  public async appendJournal(
    user_id: string,
    entry: string,
    source: 'manual' | 'auto' = 'manual'
  ): Promise<void> {
    const journalEntry: JournalEntry = {
      timestamp: new Date().toISOString(),
      entry,
      source,
    };

    await this.db.collection('agent_journal_manual').insertOne({
      ...journalEntry,
      user_id,
    });
    console.log(`📓 Manual journal appended for ${user_id} [${source}]`);
  }

  /**
   * Append a summarised agent transaction/action log entry.
   * This is NOT a journal entry; it is a machine-readable audit trail of
   * tools/commands the agent executed (Full Auto, heartbeat, etc.).
   */
  public async appendTransactionLog(
    user_id: string,
    entry: {
      source: 'full_auto' | 'heartbeat' | 'manual_tool' | 'system';
      mission_id?: string;
      task_id?: string;
      task_desc?: string;
      action: string;
      status: 'working' | 'completed' | 'error' | 'info';
      message: string;
      result?: string;
      tick?: number;
      session_id?: string;
    }
  ): Promise<void> {
    await this.db.collection('agent_transaction_log').insertOne({
      user_id,
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }

  /**
   * Correct or deprecate a previous manual journal entry.
   * Marks old entry as deprecated and adds a correction entry.
   */
  public async correctJournal(
    user_id: string,
    entryIndex: number,
    correction: string
  ): Promise<void> {
    const entries = await this.db.collection('agent_journal_manual')
      .find({ user_id })
      .sort({ timestamp: 1 })
      .toArray();
    if (entryIndex < 0 || entryIndex >= entries.length) return;

    const targetId = entries[entryIndex]._id;

    // Mark old entry as deprecated
    await this.db.collection('agent_journal_manual').updateOne(
      { _id: targetId },
      { $set: { deprecated: true } }
    );

    // Add correction entry
    await this.db.collection('agent_journal_manual').insertOne({
      user_id,
      timestamp: new Date().toISOString(),
      entry: correction,
      source: 'correction',
      corrects_index: entryIndex,
    });

    console.log(`📓 Journal entry ${entryIndex} corrected for ${user_id}`);
  }

  /**
   * Get active (non-deprecated) journal entries, most recent first.
   * Filters out legacy deprecated entries and sorts by timestamp.
   */
  /**
   * Get active (non-deprecated) manual journal entries, most recent first.
   */
  public async getActiveJournal(user_id: string): Promise<JournalEntry[]> {
    // Manual journal = explicit JOURNAL: directives + corrections only.
    // Auto-generated summaries belong in agent_journal_auto / agent_transaction_log.
    return this.db.collection('agent_journal_manual')
      .find({ user_id, deprecated: { $ne: true }, source: { $in: ['manual', 'correction'] } })
      .sort({ timestamp: -1 })
      .toArray() as Promise<JournalEntry[]>;
  }

  /**
   * Parse the assistant's response for explicit goal directives.
   * Supports: TASK_DONE:<id>, TASK_PROGRESS:<id>, ADD_TASK:<desc>,
   *           MISSION_DONE, JOURNAL:<text>, CORRECT_JOURNAL:<n>:<text>
   */
  public async parseAndApplyDirectives(
    user_id: string,
    assistantResponse: string,
    context: 'chat' | 'heartbeat' | 'autonomous' = 'chat'
  ): Promise<string[]> {
    const actions: string[] = [];
    const mission = await this.getActiveMission(user_id);

    // JOURNAL directives work even without an active mission —
    // the journal is agent-global, not mission-scoped.
    // Process JOURNAL first, before the mission check.
    // Only match standalone directives (^start of line, or after newline, or start of text)
    const isOperationalContext = context === 'heartbeat' || context === 'autonomous';
    const journalMatches = assistantResponse.match(/(?:^|\n)JOURNAL:\s*(.+?)(?:\n|$)/gi);
    if (journalMatches) {
      for (const m of journalMatches) {
        let entry = m.replace(/JOURNAL:\s*/i, '').trim();
        if (entry) {
          // Summarize if entry is verbose (>200 chars or >2 sentences)
          const sentenceCount = entry.split(/[.!?]/).filter(s => s.trim().length > 10).length;
          if (entry.length > 200 || sentenceCount > 2) {
            entry = await this.summarizeForJournal(entry);
          }

          if (isOperationalContext) {
            // Operational contexts (heartbeat, Full Auto) write to the heartbeat
            // journal so they don't pollute the agent's personal diary.
            await this.appendHeartbeatJournal(user_id, entry);
            actions.push(`Heartbeat journal: ${entry.slice(0, 80)}...`);
          } else {
            await this.appendJournal(user_id, entry, 'manual');
            actions.push(`Journal: ${entry.slice(0, 80)}...`);

            // Also push to active mission's self_journal (mission-scoped journaling)
            if (mission) {
              await this.db.collection('memory_missions').updateOne(
                { _id: mission._id },
                {
                  $push: {
                    self_journal: {
                      timestamp: new Date().toISOString(),
                      entry,
                      source: 'manual',
                    },
                  },
                }
              );
            }
          }
        }
      }
    }

    // Fallback: detect conversational "I'm journaling this" and extract the insight.
    // This only applies to chat context; operational contexts should use explicit
    // JOURNAL: directives or the transaction log.
    if (!isOperationalContext && actions.length === 0 && /I'm journaling this/i.test(assistantResponse)) {
      const precedingText = assistantResponse.split(/I'm journaling this/i)[0].trim();
      const lastParagraph = precedingText.split(/\n\n/).pop()?.trim() || '';
      const lastSentence = lastParagraph.split(/[.!?]/).filter(s => s.trim().length > 20).pop()?.trim();
      const entry = lastSentence ? lastSentence + '.' : lastParagraph.slice(-200);
      if (entry.length > 10) {
        await this.appendJournal(user_id, entry, 'manual');
        actions.push(`Journal (conversational fallback): ${entry.slice(0, 80)}...`);
      }
    }

    if (!mission) return actions;

    // TASK_DONE: t1 or TASK_COMPLETE: t1
    // Anchored to line-start to prevent false positives in natural language
    const doneMatches = assistantResponse.match(/(?:^|\n)TASK_(DONE|COMPLETE):\s*(t\d+)/gi);
    if (doneMatches) {
      for (const m of doneMatches) {
        const taskId = m.match(/t\d+/i)?.[0];
        if (taskId) {
          await this.updateTaskStatus(mission._id, taskId, 'COMPLETED');
          actions.push(`Marked ${taskId} as COMPLETED`);
        }
      }
    }

    // TASK_PROGRESS: t2
    // Anchored to line-start to prevent false positives in natural language
    const progressMatches = assistantResponse.match(/(?:^|\n)TASK_PROGRESS:\s*(t\d+)/gi);
    if (progressMatches) {
      for (const m of progressMatches) {
        const taskId = m.match(/t\d+/i)?.[0];
        if (taskId) {
          await this.updateTaskStatus(mission._id, taskId, 'IN_PROGRESS');
          actions.push(`Marked ${taskId} as IN_PROGRESS`);
        }
      }
    }

    // ADD_TASK: description
    // Anchored to line-start to prevent false positives in natural language
    const addMatches = assistantResponse.match(/(?:^|\n)ADD_TASK:\s*(.+?)(?:\n|$)/gi);
    if (addMatches) {
      for (const m of addMatches) {
        const desc = m.replace(/ADD_TASK:\s*/i, '').trim();
        if (desc) {
          const currentTasks = mission.task_tree as MissionTask[];
          const newId = `t${currentTasks.length + 1 + actions.filter(a => a.startsWith('Added')).length}`;
          await this.db.collection('memory_missions').updateOne(
            { _id: mission._id },
            {
              $push: { task_tree: { id: newId, description: desc, status: 'PENDING' } },
              $set: { updated_at: new Date() },
            }
          );
          actions.push(`Added task ${newId}: ${desc}`);
        }
      }
    }

    // MISSION_DONE — only complete if ALL tasks are actually done.
    // Anchored to line-start; also guards against false positives where the
    // LLM says "when the mission is done..." in natural language.
    if (/(?:^|\n)MISSION_DONE/i.test(assistantResponse)) {
      const allDone = mission.task_tree.every(
        (t: MissionTask) => t.status === 'COMPLETED'
      );
      if (allDone) {
        await this.updateMissionStatus(mission._id, 'COMPLETED');
        actions.push('Mission marked COMPLETED');
      } else {
        const pending = mission.task_tree.filter(
          (t: MissionTask) => t.status !== 'COMPLETED'
        );
        console.warn(
          `⚠️ MISSION_DONE directive received but ${pending.length}/${mission.task_tree.length} tasks still pending — ignoring (possible false positive in natural language)`
        );
        actions.push(
          `MISSION_DONE ignored: ${pending.length} tasks still pending`
        );
      }
    }

    // CORRECT_JOURNAL: <index>:<text> — corrects a previous journal entry
    const correctMatches = assistantResponse.match(/CORRECT_JOURNAL:\s*(\d+):\s*(.+?)(?:\n|$)/gi);
    if (correctMatches) {
      for (const m of correctMatches) {
        const parts = m.replace(/CORRECT_JOURNAL:\s*/i, '').match(/^(\d+):\s*(.+)/);
        if (parts) {
          const entryIndex = parseInt(parts[1]);
          const correction = parts[2].trim();
          await this.correctJournal(user_id, entryIndex, correction);
          actions.push(`Corrected journal entry ${entryIndex}`);
        }
      }
    }


    if (actions.length > 0) {
      console.log(`📋 Applied ${actions.length} directives from assistant:`, actions);
      
      // Store directive applications as episodic events for memory recall
      try {
        const { MemoryManager } = await import('./memory-manager.js');
        const memoryManager = MemoryManager.get_instance();
        if (mission.session_id && mission.user_id) {
          await memoryManager.store_event({
            session_id: mission.session_id,
            user_id: mission.user_id,
            event_type: 'mission_update',
            content: {
              message: `Mission update: ${actions.join('; ')}`,
              directive_actions: actions,
              mission_id: mission._id,
              goal: mission.meta_goal,
            },
            metadata: {
              interface: 'directive_parser',
              timestamp: new Date().toISOString(),
              processed: false,
            }
          });
        }
      } catch (e) {
        console.warn('⚠️ Could not store directive events:', e);
      }
    }
    return actions;
  }

  /**
   * Background update of mission state after a conversation turn.
   * DeepSeek analyzes the turn and updates the internal_monologue,
   * task statuses, and optionally adds new tasks.
   */
  public async updateMissionState(
    missionId: string,
    conversationTurn: string
  ): Promise<void> {
    // Skip auto-journaling if the turn contains an explicit manual JOURNAL directive
    const hasManualJournal = /JOURNAL:\s*.+/i.test(conversationTurn);
    const mission = await this.db.collection('memory_missions').findOne({ _id: missionId });
    if (!mission || mission.status !== 'ACTIVE') return;

    try {
      const systemPrompt = `You are a mission state tracker. Analyze this conversation turn and update the mission state.
      
Current mission: "${mission.meta_goal}"
Current task tree: ${JSON.stringify(mission.task_tree)}
Current internal monologue: "${mission.internal_monologue}"

Determine:
1. What tasks were completed, progressed, or blocked in this turn?
2. What should the AI focus on next? (write as internal_monologue — 1-2 sentences from the AI's perspective)
3. Are any new sub-tasks needed?
4. Is the entire mission now complete? ONLY set true if ALL tasks are COMPLETED or the user explicitly says the mission is done. Default to false.

Return ONLY JSON:
{
  "internal_monologue": "string",
  "task_updates": [{"id": "t1", "status": "COMPLETED|IN_PROGRESS|BLOCKED"}],
  "new_tasks": [{"description": "string"}],
  "mission_complete": true|false
}`;

      const result = await llmService.extractJson(systemPrompt, conversationTurn.slice(0, 4000), 1000);
      const update = result as unknown as MissionUpdate;

      if (!update || !update.internal_monologue) {
        console.log('📋 Mission state update skipped — no meaningful changes detected');
        return;
      }

      // Apply task status updates
      if (update.task_updates && update.task_updates.length > 0) {
        for (const tu of update.task_updates) {
          await this.db.collection('memory_missions').updateOne(
            { _id: missionId, 'task_tree.id': tu.id },
            { $set: { 'task_tree.$.status': tu.status } }
          );
        }
      }

      // Add new tasks if needed
      if (update.new_tasks && update.new_tasks.length > 0) {
        const currentTasks = mission.task_tree as MissionTask[];
        const nextId = currentTasks.length + 1;
        const newTasks: MissionTask[] = update.new_tasks.map((t, i) => ({
          id: `t${nextId + i}`,
          description: t.description,
          status: 'PENDING' as const,
        }));
        await this.db.collection('memory_missions').updateOne(
          { _id: missionId },
          { $push: { task_tree: { $each: newTasks } } }
        );
      }

      // Update internal monologue
      await this.db.collection('memory_missions').updateOne(
        { _id: missionId },
        { $set: { internal_monologue: update.internal_monologue, updated_at: new Date() } }
      );

      // Auto-journal: append internal monologue as a concise insight to agent_journal_auto
      // Skip if the turn already has a manual JOURNAL: directive to avoid duplication
      if (!hasManualJournal && update.internal_monologue && update.internal_monologue.length > 10) {
        await this.appendAutoJournal(
          mission.user_id,
          update.internal_monologue,
          missionId,
          mission.meta_goal
        );
      } else if (hasManualJournal) {
        console.log(`📓 Auto-journal skipped for ${missionId} — manual JOURNAL: directive present`);
      }

      // Mark complete if done
      if (update.mission_complete) {
        await this.updateMissionStatus(missionId, 'COMPLETED');
        console.log(`🎉 Mission complete: ${missionId}`);
      }

      console.log(`📋 Mission state updated: ${missionId}`);
    } catch (error) {
      console.error('❌ Mission state update failed:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Format the active mission context for LLM prompt injection.
   * Compact — only the internal_monologue + next 2 pending tasks.
   */
  public async getMissionContextAsString(user_id: string): Promise<string> {
    const mission = await this.getActiveMission(user_id);
    if (!mission) return '';

    const pendingTasks = mission.task_tree
      .filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS')
      .slice(0, 2);

    let context = `\n[Active Mission Context]:\n`;
    context += `Goal: ${mission.meta_goal}\n`;
    context += `Status: ${mission.status}\n`;
    context += `My focus: ${mission.internal_monologue}\n`;

    if (pendingTasks.length > 0) {
      context += `Next tasks:\n`;
      pendingTasks.forEach((t) => {
        const icon = t.status === 'IN_PROGRESS' ? '🔄' : '⏳';
        context += `  ${icon} ${t.description}\n`;
      });
    }

    // Full task tree summary
    const completed = mission.task_tree.filter((t) => t.status === 'COMPLETED').length;
    const total = mission.task_tree.length;
    context += `Progress: ${completed}/${total} tasks complete\n`;

    // Active journal entries from agent_state (non-deprecated, most recent first)
    const activeJournal = await this.getActiveJournal(mission.user_id);
    if (activeJournal.length > 0) {
      context += `\nRecent journal entries (newest first, corrections marked):\n`;
      for (const entry of activeJournal.slice(0, 6)) {
        const prefix = entry.corrected ? '✏️[CORRECTION]' : entry.source === 'auto' ? '🤖' : '📝';
        context += `  ${prefix} ${entry.entry.slice(0, 150)}${entry.entry.length > 150 ? '...' : ''}\n`;
      }
    }

    return context;
  }

  /**
   * Edit a task's description.
   */
  public async editTask(
    missionId: string,
    taskId: string,
    description: string
  ): Promise<void> {
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId, 'task_tree.id': taskId },
      {
        $set: { 'task_tree.$.description': description, updated_at: new Date() },
      }
    );
  }

  /**
   * Delete a task from the task tree.
   */
  public async deleteTask(
    missionId: string,
    taskId: string
  ): Promise<void> {
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId },
      {
        $pull: { task_tree: { id: taskId } },
        $set: { updated_at: new Date() },
      }
    );
  }

  /**
   * Add a new task to the task tree.
   */
  public async addTask(
    missionId: string,
    description: string,
    status: MissionTask['status'] = 'PENDING'
  ): Promise<void> {
    const newTask: MissionTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description,
      status,
    };
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId },
      {
        $push: { task_tree: newTask },
        $set: { updated_at: new Date() },
      }
    );
  }

  /**
   * Edit the mission's meta_goal.
   */
  public async editMissionGoal(
    missionId: string,
    meta_goal: string
  ): Promise<void> {
    await this.db.collection('memory_missions').updateOne(
      { _id: missionId },
      {
        $set: { meta_goal, updated_at: new Date() },
      }
    );
  }

  /**
   * Edit a manual journal entry's text (by index).
   */
  public async editJournalEntry(
    user_id: string,
    entryIndex: number,
    newText: string
  ): Promise<void> {
    const entries = await this.db.collection('agent_journal_manual')
      .find({ user_id })
      .sort({ timestamp: 1 })
      .toArray();
    if (entryIndex < 0 || entryIndex >= entries.length) return;
    const targetId = entries[entryIndex]._id;

    await this.db.collection('agent_journal_manual').updateOne(
      { _id: targetId },
      {
        $set: {
          entry: newText,
          timestamp: new Date().toISOString(),
          source: 'manual',
        },
      }
    );
  }

  /**
   * Delete (soft-delete) a manual journal entry by marking it deprecated.
   */
  public async deleteJournalEntry(
    user_id: string,
    entryIndex: number
  ): Promise<void> {
    const entries = await this.db.collection('agent_journal_manual')
      .find({ user_id })
      .sort({ timestamp: -1 })  // DESC — matches frontend display order
      .toArray();
    if (entryIndex < 0 || entryIndex >= entries.length) return;
    const targetId = entries[entryIndex]._id;

    await this.db.collection('agent_journal_manual').updateOne(
      { _id: targetId },
      { $set: { deprecated: true } }
    );
  }

  /**
   * Edit a manual journal entry by its MongoDB _id.
   * Returns true if the entry existed and was updated.
   */
  public async editJournalEntryById(
    user_id: string,
    entryId: string,
    newText: string
  ): Promise<boolean> {
    if (!ObjectId.isValid(entryId)) return false;
    const result = await this.db.collection('agent_journal_manual').updateOne(
      { _id: new ObjectId(entryId), user_id },
      {
        $set: {
          entry: newText,
          timestamp: new Date().toISOString(),
          source: 'manual',
        },
      }
    );
    return result.matchedCount > 0;
  }

  /**
   * Delete (soft-delete) a manual journal entry by its MongoDB _id.
   * Returns true if the entry existed and was deprecated.
   */
  public async deleteJournalEntryById(
    user_id: string,
    entryId: string
  ): Promise<boolean> {
    if (!ObjectId.isValid(entryId)) return false;
    const result = await this.db.collection('agent_journal_manual').updateOne(
      { _id: new ObjectId(entryId), user_id },
      { $set: { deprecated: true } }
    );
    return result.matchedCount > 0;
  }

  /**
   * Distill episodic events that have fallen outside the 10-event sliding window.
   * Groups events into user+assistant turns, distills each aged-out turn into a
   * concise 1-2 sentence insight, and stores it in agent_journal_auto for long-term
   * searchable memory. Marks source events with metadata.auto_journaled=true.
   *
   * Called after every assistant response — only does work when episodic count > 10.
   * This is the long-term memory bridge: as turns age out of the conversational
   * window, they get distilled once and become searchable later.
   */
  public async distillAgedTurns(
    user_id: string,
    session_id: string
  ): Promise<number> {
    try {
      const WINDOW = 10;
      const MAX_TURNS_PER_CYCLE = 10;
      const BATCH_SIZE = 10;

      const events = await this.db.collection('episodic_events')
        .find({
          session_id,
          user_id,
          event_type: { $in: ['conversation', 'user_message', 'assistant_response'] }
        })
        .sort({ timestamp: 1 })
        .toArray();

      if (events.length <= WINDOW) return 0;

      const agedOut = events.slice(0, events.length - WINDOW);
      const undistilled = agedOut.filter(e => !e.metadata?.auto_journaled);
      if (undistilled.length === 0) return 0;

      const turns: Array<{ user?: any; assistant?: any }> = [];
      let current: { user?: any; assistant?: any } = {};
      for (const ev of undistilled) {
        const role = ev.content?.role ||
          (ev.event_type === 'user_message' ? 'user' :
           ev.event_type === 'assistant_response' ? 'assistant' : null);
        if (role === 'user') {
          if (current.user || current.assistant) { turns.push(current); current = {}; }
          current.user = ev;
        } else if (role === 'assistant') {
          current.assistant = ev;
          turns.push(current);
          current = {};
        }
      }
      if (current.user || current.assistant) turns.push(current);

      const capped = turns.slice(0, MAX_TURNS_PER_CYCLE);
      const batches: Array<Array<{ user?: any; assistant?: any }>> = [];
      for (let i = 0; i < capped.length; i += BATCH_SIZE) {
        batches.push(capped.slice(i, i + BATCH_SIZE));
      }

      let distilled = 0;
      for (const batch of batches) {
        try {
          const turnTexts = batch.map(turn => {
            const userMsg = turn.user?.content?.message || '';
            const asstMsg = turn.assistant?.content?.message || '';
            return `User: ${userMsg.slice(0, 300)}\nAssistant: ${asstMsg.slice(0, 300)}`;
          }).filter(t => t.length >= 20);

          if (turnTexts.length === 0) continue;

          const batchText = turnTexts.map((t, i) => `[Turn ${i + 1}]\n${t}`).join('\n\n');
          const insight = await this.summarizeForJournalBatch(batchText);

          if (insight && insight.length > 10) {
            const eventIds = batch.flatMap(turn =>
              [turn.user?._id, turn.assistant?._id].filter(Boolean)
            );
            await this.db.collection('agent_journal_auto').insertOne({
              user_id,
              session_id,
              timestamp: new Date().toISOString(),
              entry: insight,
              source_event_ids: eventIds,
            });

            if (eventIds.length > 0) {
              await this.db.collection('episodic_events').updateMany(
                { _id: { $in: eventIds } },
                { $set: { 'metadata.auto_journaled': true } }
              );
            }
            distilled += batch.length;
          }
        } catch (turnErr) {
          console.warn('⚠️ Failed to distill aged turn batch:', turnErr);
        }
      }

      if (distilled > 0) {
        console.log(`📓 Distilled ${distilled} aged-out turns → agent_journal_auto (session ${session_id.slice(-12)})`);
      }
      return distilled;
    } catch (e) {
      console.warn('⚠️ distillAgedTurns failed:', e);
      return 0;
    }
  }

  /**
   * Search auto-journal entries for ones relevant to a query.
   * Uses keyword overlap for lightweight relevance matching (no LLM call).
   */
  public async searchAutoJournal(
    user_id: string,
    query: string,
    limit: number = 5
  ): Promise<AutoJournalEntry[]> {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (queryTerms.length === 0) return [];

    const entries = await this.db.collection('agent_journal_auto')
      .find({ user_id })
      .sort({ timestamp: -1 })
      .limit(200)
      .toArray() as AutoJournalEntry[];

    const scored = entries.map(e => {
      const text = (e.entry || '').toLowerCase();
      const score = queryTerms.filter(t => text.includes(t)).length / queryTerms.length;
      return { ...e, _score: score };
    });

    return scored
      .filter(e => e._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  }

  /**
   * Format auto-journal search results as context text for LLM prompt injection.
   */
  public formatAutoJournalContext(entries: AutoJournalEntry[]): string {
    if (entries.length === 0) return '';
    let ctx = '\n[Long-term memory digest — distilled insights from past conversations]:\n';
    for (const e of entries) {
      const date = new Date(e.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      ctx += `  ${date}: ${e.entry.slice(0, 200)}\n`;
    }
    return ctx;
  }

  /**
   * Auto-journal: distill a conversation turn into a concise insight and store it.
   * DEPRECATED in favour of distillAgedTurns — kept for direct API use only.
   */
  public async autoJournalTurn(
    user_id: string,
    userMessage: string,
    assistantResponse: string
  ): Promise<void> {
    try {
      const turnText = `User: ${userMessage.slice(0, 500)}
Assistant: ${assistantResponse.slice(0, 500)}`;
      const insight = await this.summarizeForJournal(turnText);
      if (insight && insight.length > 10) {
        await this.appendAutoJournal(user_id, insight);
      }
    } catch (e) {
      console.warn('⚠️ Auto-journal turn distillation failed:', e);
    }
  }

  /**
   * Append an auto-journal entry (goal tracking) to agent_journal_auto.
   */
  public async appendAutoJournal(
    user_id: string,
    entry: string,
    mission_id?: string,
    meta_goal?: string
  ): Promise<void> {
    await this.db.collection('agent_journal_auto').insertOne({
      user_id,
      timestamp: new Date().toISOString(),
      entry,
      mission_id,
      meta_goal,
    });
    console.log(`📓 Auto-journal appended for ${user_id}: ${entry.slice(0, 80)}...`);
  }

  /**
   * Get auto-journal entries for a user, most recent first.
   */
  public async getAutoJournal(user_id: string, limit: number = 50): Promise<AutoJournalEntry[]> {
    return this.db.collection('agent_journal_auto')
      .find({ user_id })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray() as Promise<AutoJournalEntry[]>;
  }

  /**
   * Append a heartbeat journal entry.
   * Heartbeat journals are operational logs produced by background heartbeat
   * or autonomous execution cycles. They are kept separate from the agent's
   * personal manual journal so that introspective diary entries are not
   * polluted with system-level observations.
   */
  public async appendHeartbeatJournal(
    user_id: string,
    entry: string,
    metadata?: { run_id?: string; task_name?: string }
  ): Promise<void> {
    const journalEntry: HeartbeatJournalEntry = {
      timestamp: new Date().toISOString(),
      entry,
      source: 'heartbeat',
      ...metadata,
    };

    await this.db.collection('heartbeat_journal').insertOne({
      ...journalEntry,
      user_id,
    });
    console.log(`⚡ Heartbeat journal appended for ${user_id}: ${entry.slice(0, 80)}...`);
  }

  /**
   * Get heartbeat journal entries for a user, most recent first.
   */
  public async getHeartbeatJournal(user_id: string, limit: number = 50): Promise<HeartbeatJournalEntry[]> {
    return this.db.collection('heartbeat_journal')
      .find({ user_id })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray() as Promise<HeartbeatJournalEntry[]>;
  }
}
