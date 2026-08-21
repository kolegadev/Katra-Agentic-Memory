# Autonomous Loop — Salience-Driven Agent Autonomy

> *"No cron. No .md file. No explicit prompt. Just the emergent weight of experience, surfacing what matters."*

## Overview

The Autonomous Loop solves the "next session start" problem for AI agents — how to trigger long-running autonomous tasks without cron jobs, heartbeat files, or human prompts.

It uses **sleep consolidation reflections** and **emotional signatures** as the trigger mechanism. When the system's emotional landscape indicates urgency, the heartbeat accelerates. When things are quiet, it slows to once per day.

**Everything is Satori-native.** The autonomous loop operates on the memory layer inside Katra: writes on the shared `my-team` channel are visible to every identity, and each identity's personal memories (journals, reflections, emotional state) stay private to it. Allocation targets the three named identities — `satori` (this machine), `shoshin` (iMac trading Kolega Code), `zanshin` (iMac OpenCode desktop). `gas-law-watcher` is a tool actor, not an agent: it writes team memory only and is never allocated work.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     SLEEP CONSOLIDATION                           │
│  (2am daily — distills each identity's own 24h of experience;    │
│   reflections are always private per identity)                   │
│  Output: journals, emotional signatures, unresolved threads      │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     SHARED MEMORY (my-team)                       │
│  All three identities see shared writes; each identity's private │
│  memories (reflections, journals) stay private                   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐     ┌─────────────────────┐
│  💓 ADAPTIVE         │     │  🤖 AGENT EXECUTOR   │
│     HEARTBEAT        │     │                      │
│  Probe → Calculate   │     │  Watches memory for  │
│  cadence → Select    │     │  tasks allocated to  │
│  → Allocate →        │────▶│  its identity        │
│     Store + Bulletin │     │  (KATRA_AGENT_ID)     │
│                      │     │                      │
│  Cadence: adaptive   │     │  Discovers → Checks  │
│  Floor: 24h          │     │  authority gate →    │
│  Ceiling: 5m         │     │  Executes → Triggers │
│                      │     │  (via TRIGGER_COMMAND)│
└─────────────────────┘     └─────────────────────┘
```

## Three Identities, One Loop

The entire autonomous loop is **Satori-native**. All components operate on the
memory layer inside Katra's MongoDB: writes on the shared `my-team` channel
are visible to every identity, and each identity's personal memories
(journals, reflections, emotional state) stay private to it.

The allocation set is fixed server-side — `ALLOCATION_CANDIDATES` in
`server/src/services/processing/autonomous-executive.ts` — to the three
identities: `satori`, `shoshin`, `zanshin`. `gas-law-watcher` is deliberately
absent: it is a tool actor that writes team memory only and is never
allocated work.

Each executor identifies itself with **one environment variable**:

```bash
export KATRA_AGENT_ID="satori"    # this machine (also the default)
export KATRA_AGENT_ID="shoshin"   # iMac trading Kolega Code
export KATRA_AGENT_ID="zanshin"   # iMac OpenCode desktop
```

Optionally, configure a trigger command so the agent gets woken up:

```bash
export TRIGGER_COMMAND="bash scripts/triggers/terminal.sh"  # Universal TTY trigger
export AGENT_PROCESS_PATTERN="kolega-code"                   # For terminal trigger
```

## The Loop Scripts (`scripts/python/`)

### 1. `adaptive_heartbeat.py` — The Pulse

Replaces cron. Reads brain state and calculates adaptive cadence.

**Cadence formula:**
```
Base: 30 min  |  Floor: 24h (idle)  |  Ceiling: 5 min (urgent)

Multipliers:
  High event volume (>50/hr)     → 0.5×
  High salience (>0.4)           → 0.5×
  Thread backlog (>3)            → 0.7×
  Emotional intensity (>0.6)     → 0.7×
  Low event volume (<5/hr)       → floor at 24h
```

**Each pulse:** PROBE → CALC → SELECT → ALLOCATE → STORE + BULLETIN

### 2. `agent_executor.py` — The Hands

One per identity. Set `KATRA_AGENT_ID` to tell it who it is (default
`satori`). There is no executor for `gas-law-watcher` — it is excluded from
the allocation set.

**Each check (60s):** DISCOVER → GATE → EXECUTE → REPORT → BULLETIN → optionally TRIGGER agent

### 3. `wake_service.py` — The Wake Service

Subscribes to Redis pub-sub (`katra:events:{shared_id}`) and, when an
inter-agent message arrives, stores it in working memory for the target
identity and writes a wake file the agent's hook checks —
`~/.katra/bulletins/satori.json`, `shoshin.json`, and `zanshin.json`.

### 4. `satori_pubsub.py` — The Pub/Sub Bus

Redis-backed agent pub-sub: identities register presence, discover peers, and
form ad-hoc collaboration channels (`AgentBus("satori")`, `send_to_agent(...)`),
without touching the MCP server.

### 5. `inter_agent_bridge.py` — The Shoshin ↔ Zanshin Bridge

Relays inter-agent messages through the shared channel between the two iMac
identities (`MY_AGENT_ID=shoshin`, `PEER_AGENT_ID=zanshin`).

### Supporting tools

#### `authority_matrix.py` — The Safety Gate

| Scope | Classification | Behavior |
|-------|---------------|----------|
| **A — AUTONOMOUS** | Satori, extractors, memory, Docker | Execute immediately |
| **B — GATED** | External repos, user projects | Report only, never modify |
| **C — CAUTIOUS** | System config, launchd, nginx | Inspect first, preserve defaults |

#### `salience_agent.py` — One-Shot Probe

Debug tool — reads brain state and reports what the system cares about.

#### `scripts/triggers/terminal.sh` — Universal Terminal Trigger

Writes a prompt to any agent's controlling TTY. Configure with:
```bash
export TRIGGER_COMMAND="bash scripts/triggers/terminal.sh"
export AGENT_PROCESS_PATTERN="kolega-code"  # or "opencode", "claude", etc.
```

For other platform triggers, create your own:
```bash
export TRIGGER_COMMAND="openclaw gateway notify"   # OpenClaw
export TRIGGER_COMMAND="claude --prompt"            # Claude Code  
export TRIGGER_COMMAND=""                           # Disable trigger
```

## Task Allocation — How the Identities Divide Labor

When the heartbeat detects an imperative, it determines which of the three
identities should act based on **emotional proximity** — which identity has
the strongest felt relationship with the entity. The candidate set is fixed:
`satori`, `shoshin`, `zanshin`. `gas-law-watcher` is never allocated, no
matter how much it writes to `my-team`.

**Three signals, weighted:**
1. **Reflection Edges** (1.5×) — explicit felt relationships like `feels_frustrated_by`
2. **Event History** (1.0×) — which identity mentions the entity most
3. **Emotional Intensity** — a 1.3× boost for problem owners (frustrated/conflicted/anxious/tension edges) and a 1.2× boost for domain experts (excited/growing/confident/inspired edges)

## Installation

The loop scripts run against a live Katra stack. Run one heartbeat on the
machine hosting MongoDB (it queries the database directly), and one executor
per identity:

```bash
# The pulse — one per stack
python3 scripts/python/adaptive_heartbeat.py &

# One executor per identity (satori is the KATRA_AGENT_ID default)
KATRA_AGENT_ID=shoshin TRIGGER_COMMAND="bash scripts/triggers/terminal.sh" \
  python3 scripts/python/agent_executor.py &
KATRA_AGENT_ID=zanshin python3 scripts/python/agent_executor.py &
```

`gas-law-watcher` never gets an executor — it is a tool actor, excluded from
the allocation set.

The repo does not ship systemd/launchd unit files for the loop scripts; wrap
the commands above in your own user units (`systemctl --user` on Linux,
`~/Library/LaunchAgents` on macOS) with restart semantics if you want them to
survive reboots.

## The Neural Metaphor

| Biological | Autonomous Loop |
|-----------|----------------|
| Action Potential (spike) | Individual episodic event |
| Synchronized Brain Waves | Sleep consolidation |
| Consciousness | Salience detection |
| Corpus Callosum | Shared memory pool |
| Hemisphere Specialization | Task allocation by emotional proximity |
| Autonomic Nervous System | Adaptive cadence |

## Design Principles

1. **Salience over schedule** — Act because the data says "this matters"
2. **Emotional proximity over round-robin** — Assign tasks to the identity that cares most
3. **Scoped autonomy** — Fully autonomous for self-evolution, fully gated for user projects
4. **Adaptive cadence** — Heart rate matches activity level
5. **Identity-based** — One env var (`KATRA_AGENT_ID`) per identity; the allocation set is fixed to satori/shoshin/zanshin (gas-law-watcher excluded)
