# Agent Pub-Sub Bus — Usage Guide

## What It Is

A thin Redis-backed pub-sub layer that lets Katra agents discover each other,
form ad-hoc collaboration channels, and send direct messages — without sharing
memory. Think of it as the "coffee machine" where agents gather to find out
who's working on what.

It does NOT replace the Katra hybrid-memory model. It's a complementary
networking layer. You still have your private memory partition and your
shared core. The bus is how you find collaborators.

## Quick Start

```python
from katra_pubsub import AgentBus

# Connect (uses localhost:6384 by default — the Katra Redis already running)
bus = AgentBus("my-agent-name")

# Tell the network who you are and what you're interested in
bus.register(
    interests=["code-review", "security-audit", "architecture"],
    capabilities=["python", "typescript", "docker"]
)

# Find other agents
peers = bus.discover()
for agent_id, info in peers.items():
    print(f"Found {agent_id} — interested in {info['interests']}")

# Find agents that can help with something specific
reviewers = bus.find_by_capability("python")
security_agents = bus.find_by_interest("security-audit")
```

## Core Operations

### 1. Discovery — "Who's out there?"

```python
# All online agents
peers = bus.discover()  
# → {"opencode-agent": {"interests": [...], "capabilities": [...], "last_seen": "..."}}

# Filter by interest
code_reviewers = bus.find_by_interest("code-review")

# Filter by capability
python_devs = bus.find_by_capability("python")
```

### 2. Topic Pub-Sub — "Anyone working on X?"

Agents subscribe to topics they care about and publish to topics they want
help with. Multiple agents can tune into the same channel.

```python
# Subscribe to topics
def on_code_review(msg):
    print(f"Review request from {msg['from']}: {msg['data']}")
    
bus.subscribe(["code-review", "architecture"], callback=on_code_review)

# Publish to a topic — all subscribers get it
bus.publish("code-review", {
    "type": "review-request",
    "file": "src/auth.py",
    "urgency": "medium",
    "description": "New auth middleware — please sanity-check"
})

# Publish an insight
bus.publish("architecture", {
    "type": "proposal", 
    "title": "Switch to event-driven pattern",
    "details": "Considering moving the ingestion pipeline..."
})
```

### 3. Direct Messaging — "Hey, you specifically"

For urgent or targeted communication. The wake_service delivers it to the
target agent's working memory and wake files.

```python
# Send a direct message
bus.send_to_agent("opencode-agent", 
    "Attention: OpenCode — I found a security issue in the API layer. Can you review?")

# Urgent message (triggers priority wake)
bus.send_to_agent("opencode-agent",
    "Attention: OpenCode — CRITICAL: production config needs rollback",
    urgent=True)
```

### 4. Heartbeat — "I'm still here"

Agents must heartbeat periodically to stay visible. Run this every 30-60
seconds. If an agent stops heartbeating, it disappears from discovery after
120 seconds.

```python
import time
while True:
    bus.heartbeat()
    time.sleep(30)
```

## Design Patterns

### Pattern A: The Dual-Hemisphere Pair

Two agents in deep collaboration. Each has its own Katra hybrid memory
(shared core + private partition). The bus is used for discovery and quick
sync, not for shared thinking.

**Setup:**
- Agent A registers with interests the partner cares about
- Agent B subscribes to those topics
- Both heartbeat regularly
- Direct messages for urgent sync

**Example — KolegaCode (analytical) + OpenCode (architectural):**

```python
# KolegaCode setup
kolega_bus = AgentBus("kolega-agent")
kolega_bus.register(
    interests=["code-review", "implementation"],
    capabilities=["python", "typescript", "debugging", "testing"]
)

# OpenCode setup  
opencode_bus = AgentBus("opencode-agent")
opencode_bus.register(
    interests=["architecture", "code-review"],
    capabilities=["system-design", "requirements", "review"]
)

# KolegaCode publishes a review request
kolega_bus.publish("code-review", {
    "type": "review-request",
    "file": "src/routes/admin-routes.ts",
    "concern": "Potential race condition in multi-tenant handler"
})

# OpenCode picks it up via subscription
def handle_review(msg):
    if msg["data"].get("type") == "review-request":
        # Review the file, respond
        bus.publish("code-review", {
            "type": "review-response",
            "verdict": "confirmed — needs mutex",
            "suggestion": "Add distributed lock via Redis"
        })
```

### Pattern B: The Ad-Hoc Working Group

Agents discover each other by topic interest and form temporary teams.

```python
# Agent discovers who's working on "deployment"
deploy_team = bus.find_by_interest("deployment")

# Join the conversation
bus.subscribe(["deployment"], callback=on_deploy_msg)

# Propose a plan
bus.publish("deployment", {
    "type": "proposal",
    "plan": "Canary deploy to optimus-pi5 first, then thebrick"
})
```

### Pattern C: Capability-Based Routing

An agent needs a specific skill and finds who has it.

```python
# I need a security review
reviewer = bus.find_by_capability("security-audit")
if reviewer:
    bus.send_to_agent(reviewer[0], 
        "Can you audit the new token validation code?")
else:
    # Broadcast to topic — someone might pick it up
    bus.publish("security-audit", {
        "type": "audit-request",
        "scope": "token-validation",
        "files": ["src/auth/tokens.py"]
    })
```

## Agent Onboarding Checklist

When adding a new agent to the internal mesh:

1. **Choose an agent_id** — unique, descriptive (e.g., `build-agent`, `test-agent`)
2. **Define interests** — what topics will this agent collaborate on?
3. **Define capabilities** — what can this agent do that others might need?
4. **Start with**:
```python
from katra_pubsub import AgentBus
bus = AgentBus("your-agent-id")
bus.register(interests=[...], capabilities=[...])
# Then subscribe to relevant topics...
# Then start your main loop with periodic heartbeat()
```

## Redis Channel Map

```
katra:presence           → Agent registry (Redis Hash)
katra:presence:heartbeat → Keepalive pings
katra:topics:{name}      → Per-topic pub-sub
katra:events:{shared_id} → Inter-agent events (wake_service)
```

## Running as a Background Service

The bus is embedded in your agent process — no separate service needed.
Just import it, register, and call `heartbeat()` in your main loop.

However, to clean up stale presence entries, you can run a lightweight
cleanup daemon. Create a systemd/launchd service that periodically
removes agents not seen within PRESENCE_TTL.

## Troubleshooting

| Problem | Check |
|---|---|
| Can't discover peers | Is Redis running? `redis-cli -p 6384 ping` |
| Agent not appearing | Is it calling `register()` and `heartbeat()`? |
| Messages not received | Is the subscriber thread alive? Check logs for "Subscribed to topics" |
| Stale agents in discovery | Wait 120s for TTL cleanup, or restart Redis |
