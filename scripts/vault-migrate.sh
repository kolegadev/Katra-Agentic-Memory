#!/usr/bin/env bash
# Katra Vault F8 migration wrapper (contract F8, criterion 7).
#
# Bundles server/src/services/vault/migration-runner.ts with esbuild (already
# a devDependency — no new deps, no build-config changes) and runs it with the
# operator's args. Dry-run is the default; nothing destructive happens without
# an explicit --apply.
#
#   scripts/vault-migrate.sh [--dry-run|--apply] [--key-file PATH] [--report-out PATH]
set -euo pipefail

cd "$(dirname "$0")/../server"

TMP="$(mktemp /tmp/vault-migrate-XXXXXX.mjs)"
trap 'rm -f "$TMP"' EXIT

npx esbuild src/services/vault/migration-runner.ts \
  --bundle --platform=node --format=esm \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" \
  --outfile="$TMP"

node "$TMP" "$@"
