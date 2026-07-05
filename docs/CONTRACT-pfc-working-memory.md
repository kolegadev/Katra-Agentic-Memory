# CONTRACT: PFC Active Working Memory — Capacity, Rehearsal, Distractor Filter

## Goal
Extend `working-memory-service` from passive Redis storage into active PFC working memory with capacity limits, decay-based rehearsal, and goal-relevance filtering. This turns the "whiteboard" into a "person using the whiteboard."

## From Research (brain-function-gap-map.md §2.3)
"Capacity limit: max 4-7 items in active set. Rehearsal loop: periodic LLM call to refresh decaying items. Distractor filter: suppress items irrelevant to active goal."

## Boundaries
- MODIFY: `working-memory-service.ts` — add capacity/rehearsal/distraction methods
- CREATE: none (extends existing)
- DO NOT TOUCH: Redis storage layer, session management

## Success Criteria
1. `addToActiveSet(sessionId, item, salience)` enforces max 5 items — evicts lowest-salience when full
2. Items have a decay timer: strength decays by 10% per minute without rehearsal
3. `rehearse(sessionId)` refreshes all items back to full strength (called on access)
4. `filterByGoal(sessionId, goalTerms)` suppresses items irrelevant to active goal
5. `getActiveItems(sessionId)` returns only items above decay threshold (strength > 0.2)
6. Backward compatible: existing `store()` / `get_session_memory()` unchanged

## Interfaces
```typescript
interface ActiveItem {
  id: string;
  content: string;
  salience: number;      // 0-1, used for eviction priority
  strength: number;      // 0-1, decays over time
  addedAt: number;
  lastRehearsedAt: number;
  tags: string[];
}

addToActiveSet(sessionId: string, content: string, salience?: number): Promise<string>;
rehearse(sessionId: string): Promise<void>;
filterByGoal(sessionId: string, goalTerms: string[]): Promise<ActiveItem[]>;
getActiveItems(sessionId: string): Promise<ActiveItem[]>;
```
