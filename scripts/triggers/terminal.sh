#!/bin/bash
# Universal terminal trigger — writes prompt to an agent's controlling TTY.
# Usage: TRIGGER_COMMAND="bash /path/to/terminal.sh"
# Finds the process matching $AGENT_PROCESS_PATTERN and writes to its TTY.

AGENT_ID="${1:-unknown}"
PROMPT="${2:-Check shared memory for tasks.}"

# Set AGENT_PROCESS_PATTERN env var to identify your agent process
PROCESS_PATTERN="${AGENT_PROCESS_PATTERN:-$AGENT_ID}"

PID=$(pgrep -f "$PROCESS_PATTERN" | head -1)
if [ -z "$PID" ]; then
  echo "[trigger] Agent process not found for pattern: $PROCESS_PATTERN"
  exit 1
fi

TTY=$(ps -o tty= -p $PID 2>/dev/null | head -1 | tr -d ' ')
if [ -z "$TTY" ]; then
  echo "[trigger] Cannot find TTY for PID $PID"
  exit 1
fi

printf "%s\r" "$PROMPT" > "/dev/$TTY" 2>/dev/null
echo "[trigger] $AGENT_ID: prompt sent to PID $PID (TTY $TTY)"
