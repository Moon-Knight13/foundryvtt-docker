#!/usr/bin/env bash
# Sync the built content module into a Foundry data directory.
# Run this on the HOST, not inside the devcontainer.
#
# Usage: scripts/content/sync-content.sh [--test] [--dry-run] [--data <path>]
#   --test     sync to $FOUNDRY_TEST_DATA_PATH instead of $FOUNDRY_DATA_PATH
#   --data     explicit data directory (overrides env vars)
#   --dry-run  show what rsync would do
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE_DIR="$REPO_ROOT/content/dist/troubled-waters-content"

DATA_PATH="${FOUNDRY_DATA_PATH:-$HOME/.local/share/FoundryVTT}"
DRY_RUN=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)
      DATA_PATH="${FOUNDRY_TEST_DATA_PATH:?--test requires FOUNDRY_TEST_DATA_PATH to be set}"
      shift ;;
    --data)
      DATA_PATH="${2:?--data requires a path}"; shift 2 ;;
    --dry-run)
      DRY_RUN=(--dry-run -v); shift ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$MODULE_DIR/module.json" ]]; then
  echo "Error: $MODULE_DIR is missing or not built. Run: node scripts/content/build.mjs" >&2
  exit 1
fi

MODULES_DIR="$DATA_PATH/Data/modules"
if [[ ! -d "$MODULES_DIR" ]]; then
  echo "Error: $MODULES_DIR does not exist — is $DATA_PATH a Foundry data dir?" >&2
  exit 1
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "${DRY_RUN[@]}" "$MODULE_DIR/" "$MODULES_DIR/troubled-waters-content/"
else
  if [[ ${#DRY_RUN[@]} -gt 0 ]]; then
    echo "Dry run (no rsync available): would replace $MODULES_DIR/troubled-waters-content with:"
    find "$MODULE_DIR" -type f
    exit 0
  fi
  rm -rf "$MODULES_DIR/troubled-waters-content"
  cp -a "$MODULE_DIR" "$MODULES_DIR/troubled-waters-content"
fi
echo "Synced troubled-waters-content -> $MODULES_DIR"
