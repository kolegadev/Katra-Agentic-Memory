#!/usr/bin/env bash
# The ONE supported way to update kolega-code on a bridge machine
# (2026-09-23 wake-ritual re-implementation, directive item d).
#
# `kolega-code update` alone = `uv tool install --force --upgrade kolega-code`,
# which REBUILDS the CLI venv and can silently orphan the bridge (2026-08-20
# incident). This wrapper runs the update and then RE-ASSERTS + VERIFIES the
# bridge before declaring success. Nothing that skips the verification is a
# completed update.
#
# Usage (per machine):
#   KATRA_USER_ID=satori KATRA_HOST=localhost      kolega-update.sh   # on the Katra host
#   KATRA_USER_ID=zefir  KATRA_HOST=<katra-host> kolega-update.sh   # on a client machine
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n== %s ==\n' "$1"; }

step "1/3 uv upgrade (this is what 'kolega-code update' does)"
uv tool install --force --upgrade kolega-code

step "2/3 bridge re-assertion (registrations + config + migration)"
"$HERE/scripts/ensure-bridge.sh" || { echo "✗ ensure-bridge failed — bridge NOT re-asserted" >&2; exit 1; }

step "3/3 verification (guard must pass or the update is not done)"
"$HERE/scripts/bridge-guard.sh" || {
  echo "✗ bridge-guard failed after update — the update is NOT accepted; fix the bridge before using the agent" >&2
  exit 1
}

printf '\nkolega-update OK — CLI upgraded and the bridge re-asserted + verified.\n'
exit 0
