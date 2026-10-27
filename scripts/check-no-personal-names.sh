#!/usr/bin/env bash
# Tracked files must not name people or agents.
#
# Deployment identities live in env vars, config and private/, never in the repository. This check
# exists because the rule was written in AGENTS.md and then violated 500+ times: a rule CI does not
# measure is an aspiration, and aspirations rot.
#
# The wordlist is in this file, so this file excludes itself from its own scan.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PATTERN='satori|lilly|zefir|zanshin|shoshin|johnpellew|\bjohn\b'

hits="$(git grep -nIiE "$PATTERN" -- . \
  ':!private' \
  ':!scripts/check-no-personal-names.sh' \
  ':!*.lock' || true)"

if [ -n "$hits" ]; then
  count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  printf '%s\n' "$hits" | head -40
  echo
  echo "::error::${count} personal or agent name(s) in tracked files — use a role word in prose, or an env/config value for an identity"
  exit 1
fi

echo "no personal or agent names in tracked files"
