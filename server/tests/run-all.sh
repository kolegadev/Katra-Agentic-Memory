#!/bin/bash
# Katra Test Suite Runner
# Usage: ./tests/run-all.sh [unit|security|integration|all]
set -e

cd "$(dirname "$0")/.."

MODE="${1:-all}"

run_unit() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  🔬 UNIT TESTS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  npx vitest run tests/unit/ --reporter=verbose
}

run_security() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  🔒 SECURITY REGRESSION TESTS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  npx vitest run tests/security/ --reporter=verbose
}

run_integration() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  🔗 INTEGRATION TESTS (requires Docker stack)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if docker ps 2>/dev/null | grep -q katra-server; then
    npx vitest run tests/integration/ --reporter=verbose --testTimeout=60000
  elif curl -sf http://localhost:9012/api/v1/health > /dev/null 2>&1; then
    npx vitest run tests/integration/ --reporter=verbose --testTimeout=60000
  else
    echo ""
    echo "  ⚠️  Katra server not detected on localhost:9012."
    echo "  Start the Docker stack or run Katra locally, then retry."
    echo ""
    exit 1
  fi
}

case "$MODE" in
  unit)
    run_unit
    ;;
  security)
    run_security
    ;;
  integration)
    run_integration
    ;;
  all)
    run_unit
    run_security
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  📊 UNIT + SECURITY: ALL PASSED ✓"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Run './tests/run-all.sh integration' for Docker-based tests."
    ;;
  *)
    echo "Usage: $0 [unit|security|integration|all]"
    exit 1
    ;;
esac
