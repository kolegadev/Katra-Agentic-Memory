/**
 * Goal Manager Service — PFC Executive Function
 *
 * Extends memory_missions with goal decomposition into dependency-aware
 * subtask graphs, progress tracking, next-action selection, and stall detection.
 *
 * This is the planning/temporal-organization core of the Prefrontal Cortex proxy.
 */

import { get_database } from '../../database/connection.js';
import { llmService } from '../infrastructure/llm-service.js';
import { stableContentHash } from '../infrastructure/content-hash-utils.js';

export interface DependencyTask {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];
  estimatedEffort: 'small' | 'medium' | 'large';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  completedAt?: Date;
}

export interface GoalPlan {
  goalId: string;
  userId: string;
  goalText: string;
  subtasks: DependencyTask[];
  decompositionHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const DECOMPOSITION_PROMPT = `Break this goal into 3-7 subtasks with dependency ordering.
Return ONLY valid JSON in this shape:
{
  "subtasks": [
    { "id": "t1", "title": "short task name", "dependsOn": [], "estimatedEffort": "small|medium|large" },
    { "id": "t2", "title": "short task name", "dependsOn": ["t1"], "estimatedEffort": "small|medium|large" }
  ]
}
Rules:
- No circular dependencies (t2 can depend on t1, but t1 cannot depend on t2)
- Each subtask independently verifiable
- Foundational tasks first (no dependencies)
- estimatedEffort: small=hours, medium=days, large=weeks
- Max 7 subtasks`;

const STALL_THRESHOLD_HOURS = 24;

export class GoalManager {
  private static instance: GoalManager;

  static get_instance(): GoalManager {
    if (!GoalManager.instance) GoalManager.instance = new GoalManager();
    return GoalManager.instance;
  }

  /**
   * Decompose a goal into a dependency-aware subtask graph.
   * Idempotent: same goal text produces same plan (content-hash dedup).
   */
  async decomposeGoal(userId: string, goalText: string): Promise<GoalPlan> {
    const db = get_database();
    const decompositionHash = stableContentHash(userId, goalText);

    // Check cache first
    const existing = await db.collection('goal_plans').findOne({ decompositionHash });
    if (existing) {
      return this.hydratePlan(existing);
    }

    // Call LLM for decomposition
    let subtasks: DependencyTask[] = [];
    try {
      const prompt = `${DECOMPOSITION_PROMPT}\n\nGoal: "${goalText}"`;
      const result = await llmService.extractJson(
        'Break goals into dependency-ordered subtasks. Return ONLY JSON.',
        prompt,
        1200
      );
      const rawTasks: any[] = (result as any)?.subtasks || [];
      if (rawTasks.length > 0) {
        subtasks = rawTasks.map((t: any, i: number) => ({
          id: t.id || `t${i + 1}`,
          title: t.title || t.description || `Task ${i + 1}`,
          description: t.description,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
          estimatedEffort: ['small', 'medium', 'large'].includes(t.estimatedEffort)
            ? t.estimatedEffort : 'medium',
          status: 'pending' as const,
        }));
        // Validate no circular deps
        if (this.hasCircularDependency(subtasks)) {
          // Flatten: remove all dependencies and make sequential
          subtasks.forEach((t, i) => {
            t.dependsOn = i > 0 ? [subtasks[i - 1].id] : [];
          });
        }
      }
    } catch {
      // Fallback: single task
      subtasks = [{ id: 't1', title: goalText, dependsOn: [], estimatedEffort: 'medium', status: 'pending' }];
    }

    // Mark first unblocked task as in_progress
    const first = subtasks.find(t => t.dependsOn.length === 0);
    if (first) first.status = 'in_progress';

    const plan: GoalPlan = {
      goalId: `goal_${Date.now()}`,
      userId,
      goalText,
      subtasks,
      decompositionHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('goal_plans').insertOne(this.serializePlan(plan));
    return plan;
  }

  /**
   * Get the next unblocked, uncompleted subtask.
   * Respects dependency ordering: a task is only available when all its
   * dependencies are completed.
   */
  getNextAction(plan: GoalPlan): DependencyTask | null {
    for (const task of plan.subtasks) {
      if (task.status === 'completed' || task.status === 'blocked') continue;
      const allDepsDone = task.dependsOn.every(depId =>
        plan.subtasks.find(t => t.id === depId)?.status === 'completed'
      );
      if (allDepsDone) return task;
    }
    return null; // All done or all blocked
  }

  /**
   * Update a task's status. If completed, auto-unblock dependent tasks.
   */
  async updateTaskProgress(
    plan: GoalPlan,
    taskId: string,
    status: DependencyTask['status']
  ): Promise<GoalPlan> {
    const task = plan.subtasks.find(t => t.id === taskId);
    if (!task) return plan;

    task.status = status;
    if (status === 'completed') {
      task.completedAt = new Date();
      // Auto-unblock dependents
      for (const t of plan.subtasks) {
        if (t.status === 'blocked' && t.dependsOn.every(depId =>
          plan.subtasks.find(st => st.id === depId)?.status === 'completed'
        )) {
          t.status = 'pending';
        }
      }
    }
    plan.updatedAt = new Date();

    const db = get_database();
    await db.collection('goal_plans').updateOne(
      { goalId: plan.goalId },
      { $set: { subtasks: plan.subtasks.map(t => this.serializeTask(t)), updatedAt: plan.updatedAt } }
    );

    return plan;
  }

  /**
   * Completion percentage based on completed vs total subtasks.
   */
  getCompletionPercent(plan: GoalPlan): number {
    if (plan.subtasks.length === 0) return 0;
    const completed = plan.subtasks.filter(t => t.status === 'completed').length;
    return parseFloat(((completed / plan.subtasks.length) * 100).toFixed(1));
  }

  /**
   * Detect if a goal has stalled — no progress in STALL_THRESHOLD_HOURS.
   */
  detectStalledGoal(plan: GoalPlan): boolean {
    const hoursSinceUpdate = (Date.now() - plan.updatedAt.getTime()) / (1000 * 60 * 60);
    const hasIncomplete = plan.subtasks.some(t => t.status !== 'completed');
    return hasIncomplete && hoursSinceUpdate > STALL_THRESHOLD_HOURS;
  }

  /**
   * Load a plan by goal ID.
   */
  async loadPlan(goalId: string): Promise<GoalPlan | null> {
    const db = get_database();
    const doc = await db.collection('goal_plans').findOne({ goalId });
    return doc ? this.hydratePlan(doc) : null;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private hasCircularDependency(tasks: DependencyTask[]): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (taskId: string): boolean => {
      if (inStack.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visited.add(taskId);
      inStack.add(taskId);
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        for (const depId of task.dependsOn) {
          if (dfs(depId)) return true;
        }
      }
      inStack.delete(taskId);
      return false;
    };

    for (const task of tasks) {
      if (dfs(task.id)) return true;
    }
    return false;
  }

  private serializePlan(plan: GoalPlan): any {
    return { ...plan, subtasks: plan.subtasks.map(t => this.serializeTask(t)) };
  }

  private serializeTask(t: DependencyTask): any {
    return { ...t };
  }

  private hydratePlan(doc: any): GoalPlan {
    return {
      goalId: doc.goalId,
      userId: doc.userId,
      goalText: doc.goalText,
      subtasks: (doc.subtasks || []).map((t: any) => ({
        ...t,
        completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
      })),
      decompositionHash: doc.decompositionHash,
      createdAt: new Date(doc.createdAt),
      updatedAt: new Date(doc.updatedAt),
    };
  }
}
