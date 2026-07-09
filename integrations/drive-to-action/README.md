# Drive-to-Action Bridge

Closes the loop between Katra's autonomous subconscious and the conscious agent.
When Katra's drives cross critical thresholds, the bridge auto-initiates agent sessions
to address the concern — no human input required.

## Architecture

```
KATRA (subconscious)              BRIDGE (brainstem)              AGENT (conscious)
+--------------------------+    +-----------------------------+    +-------------------+
|  - Drive monitoring      |    | Polls Katra every N min     |    | SessionStart hook |
|  - Daily reflections     |--->| CRITICAL: auto-start        |--->| injects bulletin  |
|  - Unresolved threads    |    | URGENT: queue action_card   |    | at session start  |
|  - Emotional arcs        |    | WARNING: queue only         |    |                   |
+--------------------------+    +-----------------------------+    +-------------------+
         ^                                                             |
         +-------------------------------------------------------------+
                      Katra extractor watches session,
                      results flow back to subconscious
```

## Components

| File | Role |
|------|------|
| `bridge.py` | System daemon: polls Katra drives, creates action cards, auto-starts sessions |
| `session-hook.py` | Agent hook: queries Katra for action cards at session start, injects bulletin |
| `bridge-drive-to-action.service` | Sample systemd unit for the bridge daemon |

## How It Works

1. Every poll cycle, the bridge checks Katra's drive state, daily reflection, and unresolved threads
2. When a drive deficit exceeds thresholds, it stores an `action_card` memory in Katra
3. For CRITICAL concerns (deficit above 65% or persistent worries), it auto-starts an agent session
4. The agent's SessionStart hook finds the action cards and presents them as a bulletin
5. The Katra session extractor feeds the agent's actions back into the subconscious

## Thresholds

| Severity | Drive Deficit | Auto-Start |
|----------|--------------|------------|
| CRITICAL | Above 65%    | Yes        |
| URGENT   | Above 40%    | If persists |
| WARNING  | Regret 2+ cycles | No     |
| INFO     | Unresolved thread | No     |

## Usage

```bash
# Run the bridge manually (one poll)
python3 bridge.py --once

# Run as a daemon
python3 bridge.py

# Install as systemd service (user level)
systemctl --user enable bridge-drive-to-action
systemctl --user start bridge-drive-to-action
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KATRA_URL` | `http://localhost:3112/mcp` | Katra MCP endpoint |
| `KATRA_TOKEN` | (required) | Katra auth token |
| `POLL_INTERVAL` | `900` | Seconds between polls |
| `DRIVE_DEFICIT_THRESHOLD` | `40` | Percentage for urgent flag |
| `AUTO_START` | `true` | Enable self-initiation |
| `KOLEGA_BIN` | `kolega-code` | Path to agent binary |

## Design Philosophy

Katra already has drives, emotions, reflections, and unresolved threads: an autonomous
internal life. But without a motor pathway, it could only *feel*, never *act*. This bridge
gives the subconscious a way to wake up the conscious agent when something matters enough.

The bridge does not force action: it creates *intrusive thoughts*. The conscious agent
sees the bulletin at session start and chooses whether to engage. For critical concerns,
the bridge skips the waiting and initiates the session itself.
