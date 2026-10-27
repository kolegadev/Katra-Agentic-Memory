#!/bin/bash
# Iteration 1 decisive test — genuine context clear, three separate processes.
# creator: fresh process, builds the mission, prints ONLY the mission id, exits.
# resumer: a NEW process whose ONLY input is the mission id — no transcript,
#          no shared file, no conversation history.
# defect #5: every run tee-captures a log under runs/ (evidence artefact).
set -e
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd "$(dirname "$0")"

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p runs
LOG="runs/run-$TS.log"
{
  echo "=== harness run $TS ==="
  echo "commit: $(git -C "${KATRA_REPO:-$HOME/Katra-Agentic-Memory}" rev-parse --short HEAD 2>/dev/null || echo n/a)"
  echo ""
  echo "=== PHASE A: creator process (fresh) ==="
  OUT=$(node creator.mjs)
  echo "$OUT"
  MISSION_ID=$(echo "$OUT" | sed -n 's/.*mission_id=\([^ ]*\).*/\1/p')
  [ -n "$MISSION_ID" ] || { echo "FATAL: creator did not emit a mission id"; exit 1; }

  echo ""
  echo "=== PHASE B: resumer process (fresh, mission_id only) ==="
  node resumer.mjs "$MISSION_ID"

  echo ""
  echo "=== mission id for Verifier inspection: $MISSION_ID ==="
} 2>&1 | tee "$LOG"
echo "captured: $LOG"
