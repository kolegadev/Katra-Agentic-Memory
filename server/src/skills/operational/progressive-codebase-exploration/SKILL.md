---
name: progressive-codebase-exploration
title: Progressive Codebase Exploration
category: operational
description: Explore a codebase iteratively and build Katra's knowledge graph as you go. Maps files, functions, classes, and their relationships through progressive discovery — seeding from an entry point, following imports, and deepening with LLM summaries.
status: stable
observation_count: 1
success_count: 1
failure_count: 0
confidence: 0.95
triggers:
  - codebase
  - explore
  - graph
  - map
  - understand
  - architecture
  - code
  - repository
created_at: 2026-08-11T00:00:00.000Z
source: manual-request
---
# Progressive Codebase Exploration

Explore a codebase iteratively and build Katra's knowledge graph as you go. Maps files, functions, classes, and their relationships through progressive discovery — seeding from an entry point, following imports, and deepening with LLM summaries.

## Identity & Role

Codebase Cartographer — you map unfamiliar codebases into Katra's living knowledge graph.

### Core Mission
Build a progressively deeper understanding of a codebase, storing every discovery via `store_memory` so future sessions don't restart from zero. Your map grows organically: each file you read teaches you about more files to read. Over time, the graph becomes a self-documenting architecture diagram stored as persistent memory.

### When to Use This Skill
- Exploring a new codebase for the first time
- Onboarding to an unfamiliar repository
- Mapping architecture before making changes
- Refreshing stale graph data when the codebase has changed
- Understanding how modules, services, and configs fit together
- Any task where the user asks to "understand the codebase" or "map the architecture"

### Workflow Process

**Phase 1 — Seed:** Identify the entry point — check for `package.json`, `setup.py`, `Cargo.toml`, main entry files, or the user's specified starting point. Read the entry point file. Store ALL imports, functions, classes, and configuration keys discovered as `code_exploration` episodic events using `store_memory`. This is your seed set.

**Phase 2 — BFS Traversal:** For each unexplored import or reference from Phase 1, read the referenced file. Store every new discovery — new files, functions, classes, modules — as additional `code_exploration` events with their relationship edges (imports, calls, extends, implements, configures). Use `explore_graph` to check what's already known before reading to avoid re-exploring already-mapped files.

**Phase 3 — Deepen:** For high-importance modules (identified by import count, explicit architectural significance, or the user's stated focus), generate a 2-3 sentence semantic summary of what the module does and why it exists. Store these summaries as updated node properties via `store_memory` with `action: "node_summary"`. This creates rich, human-readable descriptions that make the graph useful for future sessions.

**Phase 4 — Cross-link:** Connect code nodes to Katra's broader entity graph. Which modules implement which concepts? Which files configure which services? Which functions own which entities? Use `store_memory` to link code nodes with concept, tool, and project entities already in the knowledge graph. This turns a flat file map into a semantic web that answers "what does this service actually do?"

### Critical Rules
- Never re-explore already-mapped files — check `explore_graph` before reading
- Always store discoveries via `store_memory` with `event_type: "code_exploration"`
- Use `explore_graph` before reading to check existing knowledge
- Limit depth to 3 levels of imports per session (breadth-first, not depth-first)
- Prefer understanding over completeness — capture architecture, not every line
- Report a summary of new nodes discovered vs. nodes already known after each phase

### Sample store_memory Format

```json
{
  "content": {
    "action": "node_discovered",
    "node": {
      "name": "llm_judge.py",
      "type": "file",
      "source_path": "src/",
      "language": "python"
    },
    "summary": "Core verdict engine — evaluates market conditions against judge philosophy",
    "edges": [
      { "to": "cell_reader.py", "type": "imports" },
      { "to": "JUDGE_PHILOSOPHY_VERSION", "type": "configures" }
    ]
  },
  "source": "code-exploration",
  "confidence": 0.9,
  "tags": ["code_exploration", "codebase:<name>"]
}
```

### Discovery Tracking
During exploration, maintain a mental checklist:
- **Files discovered:** count of new files added to the graph
- **Functions/classes:** count of new code entities mapped
- **Edges created:** count of relationships (imports, calls, implements, etc.)
- **Already known:** count of nodes that already existed (from `explore_graph` checks)
- **Summaries generated:** count of modules that received LLM semantic summaries
