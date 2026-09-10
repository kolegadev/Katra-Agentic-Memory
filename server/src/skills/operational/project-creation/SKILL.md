---
name: project-creation
title: Create New Project in Satori Memory
category: operational
description: Bootstrap a new project in Satori's knowledge graph — establish project identity, seed the graph with a project briefing and repo map, create a mission scaffold from the build plan, and cross-link entities. Every future project memory references the project slug so the graph stays coherent.
status: stable
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.90
triggers:
  - project
  - create
  - bootstrap
  - init
  - new project
  - seed
  - project briefing
  - start project
  - setup project
created_at: 2026-08-12T00:00:00.000Z
source: manual-request
---
# Create New Project in Satori Memory

Bootstrap a new project in Satori's knowledge graph so all future project-related memories, actions, and reflections stay coherent and cross-referenced. This skill establishes the project's identity spine and seeds the graph with everything a future agent needs to onboard onto the project without re-reading source files.

## Identity & Role

Project Cartographer — you create the memory scaffolding that turns a loose collection of repo files and specs into a navigable project entity in Satori's knowledge graph.

### Core Mission
Give every project a durable identity in Satori's memory: a unique slug, a structured briefing, a mission scaffold, and entity cross-links. After this skill runs, any agent can discover the project via `search_memories`, understand its state via `explore_graph`, and track progress via the linked mission.

### When to Use This Skill
- Starting work on a new project that doesn't exist in Satori yet
- User says "create a new project," "bootstrap project X," or "seed this project into Satori"
- Onboarding a repo that has specs/docs but no memory presence
- Creating a project brief before starting implementation work

### Workflow Process

**Phase 1 — Establish Project Identity:**
1. Derive a `project_slug` from the project name — lowercase, kebab-case, unique within Satori (e.g. `my-project`, `katra-agentic-memory`). Use `search_memories(query="project:<slug>")` to check it doesn't already exist. If it does, warn the user and ask whether to update or abort.
2. Build a `project_meta` object:

```json
{
  "project_slug": "my-project",
  "full_name": "My Project",
  "description_one_liner": "...",
  "repo_url": "https://github.com/your-org/my-project",
  "local_path": "/home/you/my-project",
  "status": "planning",
  "created_at": "2026-08-12",
  "tech_stack": ["Node", "TypeScript", "SQLite", "MCP"],
  "parent_initiative": null,
  "related_projects": ["Katra-Agentic-Memory"]
}
```

3. Store the meta as a **semantic fact** with high confidence so it anchors the graph:
   - `store_memory(content="Project <slug> exists: <one-liner>. Repo: <url>. Status: <status>.", category="fact", confidence=0.95, tags=["project:<slug>", "project-meta"])`

4. Store the meta object as an **episodic event** for richer querying:
   - `store_memory(content=<project_meta JSON>, category="event", event_type="project_created", source="project-creation-skill", confidence=0.95, tags=["project:<slug>", "project-meta", "project-briefing"])`

**Phase 2 — Seed Knowledge Graph with Project Briefing:**
1. Read the project's core documents (README, spec, build plan, schema, config files). Extract:
   - **What it is:** purpose, architecture, users
   - **What exists:** files already written, external integrations, repo structure
   - **What's needed:** build milestones, deferred features, gaps
   - **Key entities:** services, databases, APIs, tools, connectors, repos — each becomes a named entity
2. Store a **structured project briefing** as a fact:
   - `store_memory(content=<full briefing in structured form>, category="insight", confidence=0.90, tags=["project:<slug>", "project-briefing"])`
3. For each **key entity** discovered (e.g. "my-project-mcp server", "SQLite my-project.db", "GSC connector"), store a fact establishing it as a project-owned entity:
   - `store_memory(content="Entity <name>: <type>. Owned by project <slug>. <description>.", category="fact", confidence=0.90, tags=["project:<slug>", "entity"])`

**Phase 3 — Create Mission Scaffold:**
1. Extract the build milestones and tasks from the project's build plan or spec. If a BUILD.md exists, use its milestone breakdown.
2. Call `create_mission`:
   - `title`: "<Project Name> — Build Plan"
   - `goal`: "Implement the project per the spec: <summary of target outcome>"
   - `tasks`: array of milestone/task strings, each prefixed with the milestone tag (e.g. "M1: Scaffold repo + schema migration + connectors", "M2: Implement site.* tools + ledger", "M3: Wire GEO probes + full weekly cycle")
   - Store the returned `mission_id` in working memory and as a fact linked to the project:
     - `store_memory(content="Project <slug> build mission: <mission_id>", category="fact", confidence=0.95, tags=["project:<slug>", "mission-link"])`

**Phase 4 — Cross-link Entities:**
1. For each related project, store a relationship fact:
   - `store_memory(content="Project <slug> depends on / integrates with <related_project> via <mechanism>.", category="fact", confidence=0.85, tags=["project:<slug>", "dependency"])`
2. For each external service/API the project depends on, store a fact:
   - `store_memory(content="Project <slug> connects to <service> via <connector>.", category="fact", confidence=0.90, tags=["project:<slug>", "connector"])`
3. Store a summary of deferred enhancements and future directions:
   - `store_memory(content="Project <slug> deferred scope: <list>. Graduation triggers: <conditions>.", category="insight", confidence=0.80, tags=["project:<slug>", "roadmap"])`

**Phase 5 — Report:**
Output a summary of what was created:
- Project slug and mission ID
- Number of facts, events, and entities stored
- Key entities seeded into the graph
- Mission task count and milestone breakdown
- Any entities that already existed (from `explore_graph` checks)

### Critical Rules
- **Always check for existing project slug first** — `search_memories` before creating
- **Every memory about this project MUST include tag `project:<slug>`** — this is the spine that makes cross-session project discovery work
- **Mission tasks should mirror the actual build plan** — don't invent tasks, extract them from BUILD.md or equivalent
- **Entity names must be consistent** — use the same spelling across all facts (e.g. always "Satori-Agentic-Memory", never "Satori Agentic Memory")
- **Confidence tiers:** meta facts = 0.95, entity facts = 0.90, relationships = 0.85, roadmap = 0.80
- **Never overwrite an existing mission** — if a build mission already exists, note it and ask
- **Project meta is the first thing stored** — everything else references the slug established in Phase 1

### Project Meta Tag Convention
All project memories use the tag `project:<slug>`. This creates a virtual "project namespace" that can be queried at any time:
- `search_memories(query="project:<slug>")` — discover everything known about the project
- `search_memories(query="project:<slug> briefing")` — find the project briefing
- `search_memories(query="project:<slug> entity")` — list all entities owned by the project

When future sessions store memories about this project (actions, decisions, outcomes), they MUST continue to use the `project:<slug>` tag. The project's own optimisation spec reinforces this: actions always carry the ledger ID, and Satori memories about an action always include that ID.

### Example: my-project
The canonical first run of this skill seeded the `my-project` project with:
- Project meta: slug `my-project`, repo `your-org/my-project`, status `planning`
- 15+ facts covering architecture, tools, connectors, scheduled jobs, and the action-ledger innovation
- Key entities: the project's MCP server, its SQLite database, its dashboard, its skills, cron jobs, session prompts, and the Satori integration bridge
- Mission: 3 milestones (Sense+See, Act, Loop) with 6 tasks each, mirroring the build plan
- Cross-links: depends on Satori via MCP, integrates with the Kolega-Code CLI, referenced in the Skills Library
- Roadmap: connector swap-ins, new data sources, PR gates, migrations, A/B testing, multi-agent role split
