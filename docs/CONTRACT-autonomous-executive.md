# CONTRACT: Autonomous Executive Loop

## Goal
Build the conductor that ties Katra's cognitive services into a self-initiated decision-action sequence. Every ~5 minutes, the executive detects the most pressing internal drive deficit, decomposes a goal to address it, selects an action via RL, executes through the drift-diffusion gate, and records outcomes for policy learning. When all drives are satiated, it mind-wanders.

## Architecture
```
Executive.tick() (every 5 min)
  │
  ├─ 1. TICK DRIVES ──────────────────────────────────
  │     MotivationalEngine.tick()
  │     deficits = engine.getDriveDeficits()
  │     dominant = engine.getDominantDrive()
  │
  ├─ 2. DETECT DEFICIT ───────────────────────────────
  │     If avgDeficit > 0.3 → ACTION PATH
  │     If avgDeficit ≤ 0.3 → MIND-WANDER PATH
  │
  ├─ 3. ACTION PATH ──────────────────────────────────
  │     goal = generateGoalFromDeficit(dominant, deficits)
  │     plan = GoalManager.decomposeGoal(goal)
  │     task = GoalManager.getNextAction(plan)  ← RL selects
  │     result = executeTask(task)              ← drift-diffusion gates
  │     recordOutcome(result)                   ← RL learns
  │
  └─ 4. MIND-WANDER PATH ────────────────────────────
        SelfModelService.generateGoalDirectedMindWander()
```

## Boundaries
- CREATE: `autonomous-executive.ts` — new conductor service
- MODIFY: `index.ts` or `background-processor.ts` — start the executive loop
- DO NOT TOUCH: any existing service internals

## Deficit → Goal Mapping
```
coherence deficit → "Resolve contradictions in Katra knowledge graph"
novelty deficit   → "Explore unfamiliar entity or domain"
connection deficit → "Engage with OpenCoder or check inter-agent messages"
growth deficit    → "Extend Katra capabilities or fix a known limitation"
```

## Success Criteria
1. Executive loop runs every 5 minutes, logs each tick
2. When deficit > 0.3, generates and executes a goal-directed action
3. Each action feeds outcomes back to RL loop
4. When no deficit, mind-wanders with goal-directed walk
5. First action recorded as episodic event type `executive_action`
