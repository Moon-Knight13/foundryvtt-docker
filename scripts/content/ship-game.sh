#!/usr/bin/env bash
# Ship one game to the table in one command: compile its vault notes, prove
# art coverage, build the compendium module, sync it into Foundry, and restart
# the container so the new packs load.
#
# Run on the HOST — sync and restart touch the Foundry data dir and Docker,
# neither of which the devcontainer has. The compile and gate steps also run
# fine inside the devcontainer via their own CLIs; this script is the chain.
#
# Usage:
#   scripts/content/ship-game.sh "<vault>/03 Oneshots/<Game>" [--force] [--no-restart]
#     --force       recompile every note, not just stale ones
#     --no-restart  skip the Foundry container restart at the end
#
# The art gate runs --strict BETWEEN compile and build: a game with a blank
# named NPC stops here, before anything reaches Foundry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GAME_DIR=""
FORCE=""
RESTART=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE="--force" ;;
    --no-restart) RESTART=0 ;;
    --*)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
    *) GAME_DIR="$1" ;;
  esac
  shift
done

if [[ -z $GAME_DIR ]]; then
  echo 'Usage: ship-game.sh "<vault>/03 Oneshots/<Game>" [--force] [--no-restart]' >&2
  exit 1
fi
if [[ ! -d $GAME_DIR ]]; then
  echo "No such game dir: $GAME_DIR" >&2
  exit 1
fi

# Exactly one module config — zero means the game was never scaffolded for
# Foundry, two means guessing which module to ship, and we refuse to guess.
shopt -s nullglob
configs=("$GAME_DIR"/Foundry/*.config.json)
shopt -u nullglob
if [[ ${#configs[@]} -eq 0 ]]; then
  echo "No *.config.json under $GAME_DIR/Foundry — run new-game.sh first." >&2
  exit 1
fi
if [[ ${#configs[@]} -gt 1 ]]; then
  echo "Found more than one config under $GAME_DIR/Foundry: ${configs[*]}" >&2
  echo "Ship one module at a time — pass the game dir of the one you mean." >&2
  exit 1
fi
CONFIG="${configs[0]}"
SRC="$GAME_DIR/Foundry/src"

# The vault root anchors art paths; derive it from the game dir when unset.
export DND_VAULT_PATH="${DND_VAULT_PATH:-$(cd "$GAME_DIR/../.." && pwd)}"

echo "=== compile   $GAME_DIR"
node "$SCRIPT_DIR/compile-game.mjs" "$GAME_DIR" $FORCE

echo "=== art gate  $CONFIG"
node "$SCRIPT_DIR/art-coverage.mjs" --config "$CONFIG" --src "$SRC" --strict

echo "=== build     $CONFIG"
node "$SCRIPT_DIR/build.mjs" --config "$CONFIG" --src "$SRC"

echo "=== sync      $CONFIG"
"$SCRIPT_DIR/sync-content.sh" --config "$CONFIG"

if [[ $RESTART -eq 1 ]]; then
  if command -v docker > /dev/null 2>&1 && [[ -f $REPO_ROOT/compose.yml ]]; then
    echo "=== restart   foundry"
    docker compose -f "$REPO_ROOT/compose.yml" restart foundry
  else
    echo "No docker here — restart Foundry yourself so the new packs load." >&2
  fi
fi

echo "=== shipped. In Foundry: install/enable the module, import with 'Keep Document IDs'."
