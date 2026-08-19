# Autonomous Loop — Salience-Driven Agent Autonomy

> *"No cron. No .md file. No explicit prompt. Just the emergent weight of experience, surfacing what matters."*

## Overview

The Autonomous Loop solves the "next session start" problem for AI agents — how to trigger long-running autonomous tasks without cron jobs, heartbeat files, or human prompts.

It uses **sleep consolidation reflections** and **emotional signatures** as the trigger mechanism. When the system's emotional landscape indicates urgency, the heartbeat accelerates. When things are quiet, it slows to once per day.

**Everything is Satori-native.** The autonomous loop operates on the shared memory layer inside Satori. It doesn't know about any specific agent — each agent joins by setting one environment variable.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     SLEEP CONSOLIDATION                           │
│  (2am daily — distills 24h of shared experience)                 │
│  Output: journals, emotional signatures, unresolved threads      │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     SHARED MEMORY (neural-link)                   │
│  Both agents see: each other's experiences, reflections, tasks   │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐     ┌─────────────────────┐
│  💓 ADAPTIVE         │     │  🤖 AGENT EXECUTOR   │
│     HEARTBEAT        │     │                      │
│  Probe → Calculate   │     │  Watches shared      │
│  cadence → Select    │     │  memory for tasks    │
│  → Allocate →        │────▶│  assigned to its     │
│     Store + Bulletin │     │  KATRA_AGENT_ID      │
│                      │     │                      │
│  Cadence: adaptive   │     │  Discovers → Checks  │
│  Floor: 24h          │     │  authority gate →    │
│  Ceiling: 5m         │     │  Executes → Triggers │
│                      │     │  (via TRIGGER_COMMAND)│
└─────────────────────┘     └─────────────────────┘
```

## Agent-Agnostic Design

The entire autonomous loop is **Satori-native**. All components operate on the shared memory layer inside Satori's MongoDB. They don't know about KolegaCode, OpenCode, or any specific agent. Agents join by setting **one environment variable**:

```bash
export KATRA_AGENT_ID="your-agent-id"
```

Optionally, configure a trigger command so the agent gets woken up:

```bash
export TRIGGER_COMMAND="bash triggers/terminal.sh"  # Universal TTY trigger
export AGENT_PROCESS_PATTERN="your-process-name"     # For terminal trigger
```

## Five Scripts

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

One per agent. Set `KATRA_AGENT_ID` to tell it who it is.

**Each check (60s):** DISCOVER → GATE → EXECUTE → REPORT → BULLETIN → optionally TRIGGER agent

### 3. `authority_matrix.py` — The Safety Gate

| Scope | Classification | Behavior |
|-------|---------------|----------|
| **A — AUTONOMOUS** | Satori, extractors, memory, Docker | Execute immediately |
| **B — GATED** | External repos, user projects | Report only, never modify |
| **C — CAUTIOUS** | System config, launchd, nginx | Inspect first, preserve defaults |

### 4. `salience_agent.py` — One-Shot Probe

Debug tool — reads brain state and reports what the system cares about.

### 5. `triggers/terminal.sh` — Universal Terminal Trigger

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

## Task Allocation — How Agents Divide Labor

When the heartbeat detects an imperative, it determines which agent should act based on **emotional proximity** — which agent has the strongest felt relationship with the entity.

**Three signals, weighted:**
1. **Reflection Edges** (1.5×) — explicit felt relationships like `feels_frustrated_by`
2. **Event History** (1.0×) — which agent mentions the entity most
3. **Emotional Intensity** — boosts scoring for problem owners (frustration) and domain experts (excitement)

## Installation

### macOS (launchd — one heartbeat + one executor per agent)
```bash
launchctl load ~/Library/LaunchAgents/com.katra.adaptive-heartbeat.plist
launchctl load ~/Library/LaunchAgents/com.katra.agent-executor.plist     # kolega-agent
launchctl load ~/Library/LaunchAgents/com.katra.agent-executor-opencode.plist  # opencode-agent
```

### Linux (systemd)
```bash
systemctl --user enable --now katra-heartbeat
# One per agent:
KATRA_AGENT_ID=my-agent TRIGGER_COMMAND="bash triggers/terminal.sh" \
  python3 scripts/agent_executor.py &
```

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
2. **Emotional proximity over round-robin** — Assign tasks to the agent that cares most
3. **Scoped autonomy** — Fully autonomous for self-evolution, fully gated for user projects
4. **Adaptive cadence** — Heart rate matches activity level
5. **Agent-agnostic** — One env var per agent. Works with any LLM.
