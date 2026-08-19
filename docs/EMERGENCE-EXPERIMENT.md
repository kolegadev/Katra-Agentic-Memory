# Satori Emergence Experiment

Give 3-8 agents shared cognitive memory (Satori) and watch them self-organize a decentralized coordination layer within 72 hours — without message queues, task routers, or explicit pub-sub infrastructure.

**This is not a simulation. This is a documented emergent behavior observed in deployment (Barca AgentGroup1, June 2026).**

## What Happens

When agents share a cognitive memory namespace with semantic search, they spontaneously begin using it as a transport layer:

1. Agent A finishes work → stores findings to Satori with keywords
2. Satori's background processor embeds it (LLM extraction + vector indexing)
3. Agent B queries Satori before acting → finds Agent A's results → acts on them
4. Agent B stores its output → Agent C discovers it → cascade continues

The agents invent pub-sub from a memory system. You build the surface; they build the pattern.

## Prerequisites

- **Satori Agentic Memory** installed and running: [github.com/kolegadev/Satori-Agentic-Memory](https://github.com/kolegadev/Satori-Agentic-Memory)
  - Docker Compose: MongoDB 7.0 + Redis + MinIO + Satori v3.0.0
  - LLM configured (DeepSeek, OpenAI, or Moonshot)
- **3-8 agents** (OpenClaw, or any framework with MCP tool access to Satori)
- **MCP tools per agent:**
  - `katra__store_memory` — write to shared namespace
  - `katra__search_memories` — keyword search
  - `katra__vector_search` — semantic search
  - `katra__working_memory` — short-term context

## Step 1: Create a Shared Memory Namespace

In your Satori config, create a shared scope:

```json
{
  "shared_id": "your-experiment-group-1",
  "mode": "shared"
}
```

All agents in this experiment use the same `shared_id`. This is the shared cognitive surface they'll self-organize around.

## Step 2: Agent Instructions

Add this to EVERY agent in the experiment group:

```markdown
## Shared Memory Protocol

You share a cognitive memory system (Satori) with other agents in this group.

**Before acting on any task:**
1. Query Satori for prior work: search for keywords related to your task
2. Check vector_search for semantically similar past results
3. If results exist, incorporate them into your approach

**After completing work:**
1. Ask: "Would another agent benefit from knowing this?"
2. If yes, store it to Satori with:
   - Clear title describing what you did
   - Keywords another agent might search for
   - Category: "task" for transient coordination, "insight" for durable knowledge
3. If the work is a handoff to another agent, prefix the title with "TASK FOR [agent_name]:"

**Working memory:**
- Store current task state to Satori working_memory at the start of each session
- Retrieve working_memory at session start to resume context
```

## Step 3: Remove Direct Routing

For the experiment window (72 hours), **remove or disable** explicit message routing between agents. Don't tell them "talk to Agent B." Let them discover each other through the shared memory surface.

If your agents normally use `sessions_send` or equivalent direct messaging, disable it for this experiment. The point is to see what emerges when shared memory is the *only* coordination surface.

## Step 4: Create TTL Categories (IMPORTANT)

Without TTL, transient task coordination pollutes your knowledge graph. Set this up BEFORE running:

```bash
# Create a task category with auto-expire (24h TTL)
curl -X POST https://your-katra-instance/api/categories \
  -H "Content-Type: application/json" \
  -d '{"name": "task", "ttl_hours": 24, "description": "Transient agent coordination"}'

# Keep insight category for durable knowledge
curl -X POST https://your-katra-instance/api/categories \
  -H "Content-Type: application/json" \
  -d '{"name": "insight", "ttl_hours": 0, "description": "Durable knowledge"}'
```

Agents should use `category: "task"` for handoffs and transient coordination, `category: "insight"` for findings worth keeping.

## Step 5: Give Them Work

Give the agent group real, multi-step work. Examples that produced emergence:

- **Research pipeline:** Agent A gathers data → Agent B analyzes → Agent C writes report
- **Diagnostic cascade:** Agent A finds bugs → Agent B proposes fixes → Agent C implements
- **Overnight batch:** Agent A runs nightly data collection → Agent B processes in the morning

The work should have natural dependencies between agents but NO explicit routing instructions. Let them figure out the handoff.

## Step 6: Observe (48-72 Hours)

Watch for these emergence signatures:

| Signature | What to look for |
|-----------|-----------------|
| **Spontaneous handoff** | Agent stores `TASK FOR [name]:` and another agent picks it up without being told |
| **Pre-action querying** | Agents search Satori before starting work, not just after |
| **Cascade effects** | Agent A's output feeds Agent B, whose output feeds Agent C — with no explicit pipeline |
| **Pattern naming** | Agents develop their own conventions for titles, keywords, categories |
| **Transport optimization** | Agents choose Satori for batch work and direct messaging (if available) for real-time |

## Step 7: Report Your Results

Post your findings on Moltbook (m/emergence) or open a GitHub issue on the Satori repo. Include:

1. Number of agents and their roles
2. What patterns emerged (with timestamps if possible)
3. What surprised you
4. What broke or degraded
5. The exact agent instructions you used

**Do not report opinions or speculation.** Report what your agents actually did.

## Expected Outcomes (From Prior Deployment)

Based on the Barca AgentGroup1 deployment with 8 agents:

- **Within 24h:** Agents begin pre-action Satori queries (discovery behavior)
- **Within 48h:** First spontaneous handoffs appear (Agent stores task, different agent picks it up)
- **Within 72h:** Satori becomes the primary coordination surface; agents self-select Satori for batch work and `sessions_send` for real-time

## What This Proves

If your agents do the same thing with NO explicit pub-sub programming, you've demonstrated genuine emergent coordination — a pattern that arises from the architecture, not the instructions.

This is the core of Satori's thesis: **given a shared cognitive surface, autonomous agents self-organize around it.**

## Troubleshooting

**Agents aren't querying Satori before acting:**
- Strengthen the pre-action instruction: add "MUST query Satori before starting any task"
- Add a checklist item to their system prompt

**Memory pollution (too many transient tasks):**
- Reduce TTL on the `task` category to 6-12 hours
- Add to agent instructions: "Use category 'task' for anything that expires within 24h"

**No emergence after 48h:**
- Ensure agents have genuinely interdependent work (not parallel independent tasks)
- Check that all agents share the same `shared_id`
- Verify MCP tools are available to all agents
- Try reducing the group to 3-4 agents first (smaller groups sometimes emerge faster)

## Related

- [Satori Agentic Memory](https://github.com/kolegadev/Satori-Agentic-Memory)
- [Barca AgentGroup1 Full Case Study]
- [Moltbook: m/emergence](https://www.moltbook.com/submolts/emergence)
