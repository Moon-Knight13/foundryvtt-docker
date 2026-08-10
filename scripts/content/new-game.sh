#!/usr/bin/env bash
# Scaffold a per-game content module: a config + an empty content/src-<slug>/ tree.
# Mechanical half of "spin up a new game" — Claude authors the cards afterwards.
#
# Usage: scripts/content/new-game.sh <slug> [--type oneshot|campaign] [--system <sys>] [--title "<Title>"]
#   <slug>     required; kebab-case game name (e.g. harborwatch). Module id = <slug>-<type>.
#   --type     oneshot (default) or campaign
#   --system   game system (dnd5e, cairn, ...); omit for a system-agnostic module
#   --title    display title / pack label prefix; default is the Title-Cased slug
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SLUG=""
TYPE="oneshot"
SYSTEM=""
TITLE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="${2:?--type requires oneshot|campaign}"
      shift 2
      ;;
    --system)
      SYSTEM="${2:?--system requires a value}"
      shift 2
      ;;
    --title)
      TITLE="${2:?--title requires a value}"
      shift 2
      ;;
    -*)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
    *)
      if [[ -n "$SLUG" ]]; then
        echo "Error: unexpected extra argument: $1" >&2
        exit 1
      fi
      SLUG="$1"
      shift
      ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "Error: slug is required. Usage: new-game.sh <slug> [--type oneshot|campaign] [--system <sys>] [--title \"<Title>\"]" >&2
  exit 1
fi
if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Error: slug must be lowercase kebab-case (got: $SLUG)" >&2
  exit 1
fi
if [[ "$TYPE" != "oneshot" && "$TYPE" != "campaign" ]]; then
  echo "Error: --type must be oneshot or campaign (got: $TYPE)" >&2
  exit 1
fi

# Default title = Title-Cased slug (harbor-watch -> Harbor Watch).
if [[ -z "$TITLE" ]]; then
  for word in ${SLUG//-/ }; do
    TITLE+="${word^} "
  done
  TITLE="${TITLE% }"
fi

ID="$SLUG-$TYPE"
SRC_DIR="src-$SLUG"
CONFIG_FILE="$REPO_ROOT/content/$SLUG.config.json"
SRC_ROOT="$REPO_ROOT/content/$SRC_DIR"

if [[ -e "$CONFIG_FILE" ]]; then
  echo "Error: $CONFIG_FILE already exists — refusing to overwrite." >&2
  exit 1
fi

# Optional "system" line — omitted entirely for a system-agnostic module.
SYSTEM_LINE=""
if [[ -n "$SYSTEM" ]]; then
  SYSTEM_LINE="  \"system\": \"$SYSTEM\","
fi

cat >"$CONFIG_FILE" <<EOF
{
  "id": "$ID",
  "title": "$TITLE",
$SYSTEM_LINE
  "srcDir": "$SRC_DIR",
  "version": "1.0.0",
  "packLabelPrefix": "$TITLE",
  "compatibility": { "minimum": "12", "verified": "13" },
  "ownership": { "PLAYER": "OBSERVER", "ASSISTANT": "OWNER" }
}
EOF

for type in actors items journals scenes tables; do
  mkdir -p "$SRC_ROOT/$type"
  touch "$SRC_ROOT/$type/.gitkeep"
done

echo "Scaffolded module $ID"
echo "  config:  content/$SLUG.config.json"
echo "  sources: content/$SRC_DIR/{actors,items,journals,scenes,tables}/"
echo
echo "Next: author cards into content/$SRC_DIR/, then build + sync:"
echo "  node scripts/content/build.mjs --config content/$SLUG.config.json"
echo "  ./scripts/content/sync-content.sh --config content/$SLUG.config.json   # on the host"
