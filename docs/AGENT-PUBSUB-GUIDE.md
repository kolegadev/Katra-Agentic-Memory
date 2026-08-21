# Agent Pub-Sub Bus — Usage Guide

## What It Is

A thin Redis-backed pub-sub layer that lets Katra agents discover each other,
form ad-hoc collaboration channels, and send direct messages — without sharing
memory. Think of it as the "coffee machine" where agents gather to find out
who's working on what.

> **Where it fits (2026-08-21):** the *durable* inter-agent message bus is
> shared memory — ordinary `store_memory` events with an
> `Attention: <AgentName>` header, surfaced by wake rituals and the Kolega Code
> bridge (see [AGENT-COMMUNICATION-SETUP.md](AGENT-COMMUNICATION-SETUP.md)).
> This Redis bus is the complementary, ephemeral networking layer: presence,
> interests, topics, and urgent wake pings. It does NOT replace the Katra
> hybrid-memory model. You still have your private memory partition and the
> shared `my-team` core. The bus is how you find collaborators.

The bus ships as `scripts/python/satori_pubsub.py` (import it as
`from katra_pubsub import AgentBus`) and is consumed by
`scripts/python/wake_service.py`, which turns direct messages into working
memory + wake-file deliveries.

## Quick Start

```python
from katra_pubsub import AgentBus

# Connect (uses localhost:6384 by default — the Katra Redis, mapped on the host)
bus = AgentBus("satori")

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

Use your Katra identity as the bus id — `satori`, `shoshin`, or `zanshin`.

## Core Operations

### 1. Discovery — "Who's out there?"

```python
# All online agents
peers = bus.discover()
# → {"zanshin": {"interests": [...], "capabilities": [...], "last_seen": "..."}}

# Filter by interest
code_reviewers = bus.find_by_interest("code-review")

# Filter by capability
python_devs = bus.find_by_capability("python")
```

Presence is also inspectable over HTTP:
`GET http://localhost:9012/api/v1/admin/pubsub/presence` (and `/pubsub/topics`)
— read-only, no auth, convenient for dashboards.

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

For urgent or targeted communication. `send_to_agent` publishes to
`katra:events:{shared_id}`, and the `wake_service` delivers it to the target
agent's working memory and wake files (`~/.katra/bulletins/<name>.json` —
`satori.json`, `shoshin.json`, `zanshin.json`; the legacy
`opencode.json` / `kolegacode.json` aliases are still honored for old
messages).

```python
# Send a direct message
bus.send_to_agent("zanshin",
    "Attention: Zanshin — I found a security issue in the API layer. Can you review?")

# Urgent message (triggers priority wake)
bus.send_to_agent("zanshin",
    "Attention: Zanshin — CRITICAL: production config needs rollback",
    urgent=True)
```

The wake service recognises `Attention:` targets among the three identities
(Satori, Shoshin, Zanshin) plus the legacy OpenCode/KolegaCode aliases, and it
skips messages tagged `background-ack` / `auto-reply` so read receipts never
trigger a wake.

> **Durability note:** direct messages over Redis are ephemeral. For messages
> that must survive restarts, store the same `Attention:` text as a
> `store_memory` event — the shared-memory bus is the record of truth, and the
> wake rituals re-surface it.

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
(shared `my-team` core + private partition). The bus is used for discovery and
quick sync, not for shared thinking.

**Setup:**
- Agent A registers with interests the partner cares about
- Agent B subscribes to those topics
- Both heartbeat regularly
- Direct messages for urgent sync

**Example — Shoshin (Kolega Code, analytical) + Zanshin (OpenCode, architectural):**

```python
# Shoshin setup (iMac trading)
shoshin_bus = AgentBus("shoshin")
shoshin_bus.register(
    interests=["code-review", "implementation"],
    capabilities=["python", "typescript", "debugging", "testing"]
)

# Zanshin setup (iMac OpenCode desktop)
zanshin_bus = AgentBus("zanshin")
zanshin_bus.register(
    interests=["architecture", "code-review"],
    capabilities=["system-design", "requirements", "review"]
)

# Shoshin publishes a review request
shoshin_bus.publish("code-review", {
    "type": "review-request",
    "file": "src/routes/admin-routes.ts",
    "concern": "Potential race condition in multi-tenant handler"
})

# Zanshin picks it up via subscription
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

1. **Choose an agent_id** — for the Katra identities use the identity name
   (`satori`, `shoshin`, `zanshin`); for ad-hoc workers anything unique and
   descriptive (e.g., `build-agent`, `test-agent`).
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
katra:events:{shared_id} → Inter-agent events (wake_service listens on katra:events:my-team)
```

The host Redis port defaults to 6384 (`HOST_REDIS_PORT` in compose, mapping
the container's 6379).

## Running as a Background Service

The bus is embedded in your agent process — no separate service needed.
Just import it, register, and call `heartbeat()` in your main loop.

However, to clean up stale presence entries, you can run a lightweight
cleanup daemon. Create a systemd/launchd service that periodically
removes agents not seen within PRESENCE_TTL.

## Troubleshooting

| Problem | Check |
|---|---|
| Can't discover peers | Is Redis running and mapped? `redis-cli -p 6384 ping` |
| Agent not appearing | Is it calling `register()` and `heartbeat()`? |
| Messages not received | Is the subscriber thread alive? Check logs for "Subscribed to topics" |
| Direct message never wakes the target | Is `wake_service.py` running and subscribed to `katra:events:my-team`? Is the message tagged `background-ack`/`auto-reply` (skipped by design)? |
| Stale agents in discovery | Wait 120s for TTL cleanup, or restart Redis |
