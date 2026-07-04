#!/bin/bash
# Run an isolated FoundryVTT test instance against a CLONE of the live data,
# so MCP/module experiments can't touch production worlds (see CLAUDE.md,
# "Safe A/B testing").
#
# The test stack is a separate docker compose project (foundry-test) on its
# own port with its own data bind-mount. Production on :30000 is never
# stopped, restarted, or modified by this script.
#
# Usage:
#   ./scripts/test-instance.sh up [--fresh] [--dry-run]
#   ./scripts/test-instance.sh down [--dry-run]
#   ./scripts/test-instance.sh destroy [--yes] [--dry-run]
#
#   up       Clone the Foundry data dir and start the test stack on :30001.
#            Reuses an existing clone; --fresh re-clones from production data.
#   down     Stop the test stack; keep the clone for another session.
#   destroy  Stop the test stack and DELETE the clone (asks first; --yes skips).
#   --dry-run  Print the commands that would run, without executing them.
#
# Overrides: FOUNDRY_TEST_PORT (default 30001).

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT="foundry-test"
TEST_PORT="${FOUNDRY_TEST_PORT:-30001}"

# shellcheck source=scripts/lib/env-file.sh disable=SC1091
source "$REPO_ROOT/scripts/lib/env-file.sh"

DATA_PATH="$(get_env_value FOUNDRY_DATA_PATH)"
DATA_PATH="${DATA_PATH:-$HOME/.local/share/FoundryVTT}"
# Expand a leading ~ (values in .env are not shell-expanded)
DATA_PATH="${DATA_PATH/#\~/$HOME}"
CLONE_PATH="${DATA_PATH%/}-test-clone"

CMD="${1:-}"
shift || true

FRESH=false
ASSUME_YES=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    --yes) ASSUME_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    *)
      echo "❌ Unknown option: $arg (see --help in the header)"
      exit 1
      ;;
  esac
done

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "DRY-RUN: $*"
  else
    "$@"
  fi
}

# The test project must see the clone path and test port; every other value
# still comes from .env via compose's normal interpolation.
compose_test() {
  run env FOUNDRY_DATA_PATH="$CLONE_PATH" FOUNDRY_PORT="$TEST_PORT" \
    docker compose -p "$PROJECT" -f compose.yml "$@"
}

clone_data() {
  if [ "$DRY_RUN" = false ] && ! command -v rsync > /dev/null 2>&1; then
    echo "❌ rsync is required to clone the data directory."
    exit 1
  fi
  if [ ! -d "$DATA_PATH" ]; then
    echo "❌ Foundry data directory not found: $DATA_PATH"
    echo "   Set FOUNDRY_DATA_PATH in .env or start the container once first."
    exit 1
  fi

  # Pre-flight: the clone needs as much free space as the data dir occupies.
  local need_kb avail_kb
  need_kb="$(du -sk "$DATA_PATH" | cut -f1)"
  avail_kb="$(df -Pk "$(dirname "$DATA_PATH")" | awk 'NR==2 {print $4}')"
  if [ "$avail_kb" -lt "$need_kb" ]; then
    echo "❌ Not enough disk space: need $((need_kb / 1024)) MiB, have $((avail_kb / 1024)) MiB free."
    exit 1
  fi

  echo "📋 Cloning $DATA_PATH → $CLONE_PATH ($((need_kb / 1024)) MiB)..."
  run rsync -a --delete "$DATA_PATH/" "$CLONE_PATH/"
}

case "$CMD" in
  up)
    if [ -d "$CLONE_PATH" ] && [ "$FRESH" = false ]; then
      echo "ℹ️  Reusing existing clone at $CLONE_PATH (use --fresh to re-clone)."
    else
      clone_data
    fi
    echo "🚀 Starting test instance ($PROJECT) on port $TEST_PORT..."
    compose_test up -d foundry
    echo ""
    echo "✅ Test instance: http://localhost:$TEST_PORT"
    echo "   Production is untouched on its usual port."
    echo "   Install/enable the MCP bridge module HERE, not in production."
    echo "   Tear down with: $0 down   (or destroy to also delete the clone)"
    ;;
  down)
    echo "🛑 Stopping test instance ($PROJECT)..."
    compose_test down
    echo "✅ Stopped. Clone kept at $CLONE_PATH"
    ;;
  destroy)
    if [ "$ASSUME_YES" = false ] && [ "$DRY_RUN" = false ]; then
      printf "⚠️  This deletes the test clone at %s. Continue? [y/N] " "$CLONE_PATH"
      read -r reply
      case "$reply" in
        y | Y | yes | YES) ;;
        *)
          echo "Aborted."
          exit 1
          ;;
      esac
    fi
    echo "🛑 Stopping test instance ($PROJECT)..."
    compose_test down
    echo "🗑️  Deleting clone at $CLONE_PATH..."
    run rm -rf "$CLONE_PATH"
    echo "✅ Test instance destroyed. Production was never touched."
    ;;
  *)
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '1,21p'
    exit 1
    ;;
esac
