#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  Katra — rebuild the server after a code change
#
#  Usage (from anywhere in the repo):
#    scripts/shell/rebuild.sh
#
#  This rebuilds and recreates ONLY the server container. MongoDB, Redis
#  and MinIO are left running, so your memory data is untouched.
#
#  It is a thin wrapper around `install.sh --rebuild`, kept here because
#  that is where people look for scripts.
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ ! -x "$REPO_ROOT/install.sh" ]; then
    printf 'error: %s/install.sh not found or not executable\n' "$REPO_ROOT" >&2
    exit 1
fi

exec "$REPO_ROOT/install.sh" --rebuild --dir "$REPO_ROOT" "$@"
