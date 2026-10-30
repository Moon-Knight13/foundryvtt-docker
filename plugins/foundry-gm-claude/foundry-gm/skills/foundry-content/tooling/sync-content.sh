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
CONFIG="$REPO_ROOT/content/content.config.json"
# Module id from content.config.json — no jq/node dependency on the host.
MODULE_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -n 1)"
if [[ -z "$MODULE_ID" ]]; then
  echo "Error: could not read module id from $CONFIG" >&2
  exit 1
fi
MODULE_DIR="$REPO_ROOT/content/dist/$MODULE_ID"

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
  rsync -a --delete "${DRY_RUN[@]}" "$MODULE_DIR/" "$MODULES_DIR/$MODULE_ID/"
else
  if [[ ${#DRY_RUN[@]} -gt 0 ]]; then
    echo "Dry run (no rsync available): would replace $MODULES_DIR/$MODULE_ID with:"
    find "$MODULE_DIR" -type f
    exit 0
  fi
  rm -rf "${MODULES_DIR:?}/${MODULE_ID:?}"
  cp -a "$MODULE_DIR" "$MODULES_DIR/$MODULE_ID"
fi
echo "Synced $MODULE_ID -> $MODULES_DIR"
