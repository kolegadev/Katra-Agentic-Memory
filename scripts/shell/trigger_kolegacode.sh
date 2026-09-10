#!/bin/bash
# Trigger KolegaCode by writing prompt + Enter to its controlling terminal.
# This is the OpenClaw heartbeat equivalent — programmatic prompt injection.

PROMPT="${1:-Check Katra shared memory for autonomous tasks assigned to you.}"
KOLEGA_PID=$(pgrep -f "kolega-code" | head -1)

if [ -z "$KOLEGA_PID" ]; then
  echo "KolegaCode not running. Starting new session..."
  echo "$PROMPT" | "$HOME/.local/bin/kolega-code" 2>/dev/null &
  exit 0
fi

TTY=$(ps -o tty= -p $KOLEGA_PID 2>/dev/null | head -1 | tr -d ' ')

if [ -n "$TTY" ]; then
  # Write prompt + Enter to the PTY slave device
  printf "%s\r" "$PROMPT" > "/dev/$TTY" 2>/dev/null
  echo "Prompt sent to KolegaCode (PID $KOLEGA_PID, TTY $TTY)"
else
  echo "KolegaCode not found"
  exit 1
fi
