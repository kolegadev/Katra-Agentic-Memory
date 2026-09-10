# CONTRACT: PFC Goal Manager — Goal Decomposition & Progress Tracking

## Goal
Extend Katra's `memory_missions` from passive goal storage into an active executive function. The Goal Manager decomposes goals into subtask dependency graphs, selects the next unblocked action, and detects when progress stalls — providing the planning/temporal-organization core of the PFC.

## From Research (brain-function-gap-map.md §2.3)
"Goal Manager: Create, decompose, track goals. Decomposition: LLM breaks goal into sub-tasks. Dependency graph between sub-tasks. Progress monitoring via completion signals."

## Boundaries
- CREATE: `server/src/services/processing/goal-manager.ts` — new service
- MODIFY: `server/src/mcp-server.ts` — wire new MCP tools (if applicable)
- DO NOT TOUCH: memory_missions schema (compatible extension), other services
- DO NOT TOUCH: background processor, salience, motivation, RL

## Success Criteria
1. `decomposeGoal(userId, goalText)` calls LLM to break goal into subtask dependency graph
2. Subtasks stored with `depends_on: [taskId]` edges — topological ordering
3. `getNextAction(userId, goalId)` returns the highest-priority unblocked task
4. `updateTaskProgress(goalId, taskId, status)` updates task + checks if blocked tasks are now unblocked
5. `detectStalledGoal(goalId)` returns true if no progress in 24h — triggers strategy pivot signal
6. Goal completion % computable from task completion ratio
7. LLM call is cached — same goal text produces same decomposition (idempotent via content hash)
8. No circular dependencies (validation on decomposition)

## Interfaces
```typescript
export interface Subtask {
  id: string;
  title: string;
  description?: string;
  dependsOn: string[];   // task IDs that must complete first
  estimatedEffort: 'small' | 'medium' | 'large';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface GoalPlan {
  goalId: string;
  goalText: string;
  subtasks: Subtask[];
  createdAt: Date;
  decompositionHash: string;  // content hash for idempotency
}

export class GoalManager {
  decomposeGoal(userId: string, goalText: string): Promise<GoalPlan>;
  getNextAction(userId: string, goalId: string): Subtask | null;
  updateTaskProgress(goalId: string, taskId: string, status: string): Promise<void>;
  getCompletionPercent(goalId: string): number;
  detectStalledGoal(goalId: string): boolean;
}
```

## Decomposition Prompt (for LLM)
```
Break this goal into 3-7 subtasks with dependencies.
Return JSON: { "subtasks": [{ "id": "t1", "title": "...", "dependsOn": [], "estimatedEffort": "small|medium|large" }] }
Rules:
- No circular dependencies
- Each subtask is independently verifiable
- Order by dependency: foundational tasks first
```

## Expected Behavior
- Existing missions get decomposition on first access
- New missions auto-decompose on creation
- Blocked tasks auto-unblock when dependencies complete
- Stalled goals surface as unresolved threads in sleep consolidation
