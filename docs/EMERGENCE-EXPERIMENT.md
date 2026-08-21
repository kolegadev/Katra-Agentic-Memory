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

### Identity separation (2026-08-21)

The emergent behavior this experiment documents is now a shipped feature. Since 2026-08-21 Katra runs one server with three named identities — **satori**, **shoshin**, **zanshin** — resolved from the client key presented (never client self-report), plus tool actors. The inter-agent message bus makes the "spontaneous handoff" pattern a first-class convention:

- Messages are ordinary `store_memory` events in the shared scope whose text carries an `"Attention: <AgentName>"` header (e.g. `"Attention: Shoshin — the fix is merged"`).
- Wake rituals surface "messages from the team" via `search_memories` for `"Attention: Shoshin" OR "Attention: Satori" OR "Attention: Zanshin"` (limit 5).
- Read receipts are events tagged `[background-ack, read-receipt, agent-message]`; wake services skip them.

If you re-run this experiment today, give each agent its own client key so writes are stamped with distinct identities, and use the `Attention:` header instead of the old `TASK FOR [name]:` prefix.

## Prerequisites

- **Satori Agentic Memory** installed and running: [github.com/kolegadev/Satori-Agentic-Memory](https://github.com/kolegadev/Satori-Agentic-Memory)
  - Docker Compose: MongoDB 7.0 + Redis + MinIO + katra-server
  - LLM configured (DeepSeek, OpenAI, Moonshot, Ollama, or any OpenAI-compatible provider)
- **3-8 agents** (OpenClaw, or any framework with MCP tool access to Satori) — each authenticated with its own client key
- **MCP tools per agent:**
  - `store_memory` — write to shared namespace
  - `search_memories` — keyword search
  - `vector_search` — semantic search
  - `working_memory` — short-term context

## Step 1: The Shared Namespace Already Exists

Since identity separation (2026-08-21), Katra ships in hybrid mode with the team scope `shared_id: "my-team"` — no config needed. Every `store_memory` write defaults to the shared `my-team` scope (still stamped with the writer's `user_id`), so the shared cognitive surface is on by default.

Two caveats:

- **Personal kinds are always private:** `journal`, `reflection`, `emotional`, and `insight` writes are forced to the writer's `user_id` and never carry a `shared_id` — even when a shared write is requested.
- **Opt-out:** pass `private: true` to keep any other write out of the shared scope.

(This replaces the older experiment setup, which created a custom shared scope like `{"shared_id": "your-experiment-group-1", "mode": "shared"}`. The team default `my-team` does the same job.)

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
   - `tags: ["task"]` for transient coordination, `tags: ["insight"]` for durable knowledge
3. If the work is a handoff to another agent, store a message beginning with `"Attention: <AgentName>"` — the shipped inter-agent message convention (2026-08-21), surfaced by wake rituals as "messages from the team"

**Working memory:**
- Store current task state to Satori working_memory at the start of each session
- Retrieve working_memory at session start to resume context
```

## Step 3: Remove Direct Routing

For the experiment window (72 hours), **remove or disable** explicit message routing between agents. Don't tell them "talk to Agent B." Let them discover each other through the shared memory surface.

If your agents normally use `sessions_send` or equivalent direct messaging, disable it for this experiment. The point is to see what emerges when shared memory is the *only* coordination surface.

## Step 4: Separate Transient from Durable (IMPORTANT)

Transient task coordination pollutes your knowledge graph. There is **no category-TTL endpoint** in the current system — earlier drafts of this experiment referenced `POST /api/categories`, which does not exist. Separate the streams with `tags` instead:

- `store_memory(..., tags: ["task"])` for handoffs and transient coordination
- `store_memory(..., tags: ["insight"])` for findings worth keeping

Filter on the tags when querying (`search_memories` / `vector_search`), and periodically clean up stale `task` entries with `retract_memory`.

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
| **Spontaneous handoff** | Agent stores `Attention: <AgentName>` and another agent picks it up without being told |
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

Since then, the pattern has been productized as the inter-agent message bus — `Attention:` headers plus read receipts (see the identity-separation note above).

## What This Proves

If your agents do the same thing with NO explicit pub-sub programming, you've demonstrated genuine emergent coordination — a pattern that arises from the architecture, not the instructions.

This is the core of Satori's thesis: **given a shared cognitive surface, autonomous agents self-organize around it.**

## Troubleshooting

**Agents aren't querying Satori before acting:**
- Strengthen the pre-action instruction: add "MUST query Satori before starting any task"
- Add a checklist item to their system prompt

**Memory pollution (too many transient tasks):**
- Add to agent instructions: "Tag anything transient with `task`; tag durable findings with `insight`"
- Periodically retract stale `task` entries (`retract_memory`) — there is no TTL endpoint in the current system

**No emergence after 48h:**
- Ensure agents have genuinely interdependent work (not parallel independent tasks)
- Verify each agent authenticates with its own client key, so writes are stamped with distinct identities (`user_id`s)
- Check that writes land in the shared scope: the default is `shared_id: "my-team"`; make sure no agent passes `private: true` (and remember personal kinds are always private)
- Verify MCP tools are available to all agents
- Try reducing the group to 3-4 agents first (smaller groups sometimes emerge faster)

## Related

- [Satori Agentic Memory](https://github.com/kolegadev/Satori-Agentic-Memory)
- [Barca AgentGroup1 Full Case Study]
- [Moltbook: m/emergence](https://www.moltbook.com/submolts/emergence)
