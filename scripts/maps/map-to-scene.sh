#!/usr/bin/env bash
# Generate a battlemap AND its Foundry compendium Scene in one go: render the
# map (render_map.py) then convert the .dd2vtt into a Scene document under
# content/src-<slug>/scenes/. The scene ships walls + lights + doors; refine it
# by hand in the VTT afterwards.
#
# Usage:
#   scripts/maps/map-to-scene.sh <spec.json> <slug> --outdir <dir> --background <src> \
#     [--grid-distance 5] [--global-light] [--name "<Scene>"]
#
#   <spec.json>   map spec for render_map.py
#   <slug>        game slug; scene lands in content/src-<slug>/scenes/ unless
#                 --scenes-dir points elsewhere (e.g. a vault-hosted game)
#   --scenes-dir  write the Scene JSON here instead of content/src-<slug>/scenes/
#   --outdir      where render_map writes the PNGs + .dd2vtt. Point this at the
#                 map dir under the vault mount so Foundry can serve the image.
#   --background  Foundry Data-relative path to the Player PNG (compendium ships
#                 no image), e.g. "DnD/<game>/Assets/Maps/<name> - Player.png".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SPEC=""
SLUG=""
OUTDIR=""
BACKGROUND=""
NAME=""
SCENES_DIR_OVERRIDE=""
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --outdir)
      OUTDIR="${2:?--outdir requires a path}"
      shift 2
      ;;
    --background)
      BACKGROUND="${2:?--background requires a path}"
      shift 2
      ;;
    --name)
      NAME="${2:?--name requires a value}"
      shift 2
      ;;
    --scenes-dir)
      SCENES_DIR_OVERRIDE="${2:?--scenes-dir requires a path}"
      shift 2
      ;;
    --grid-distance)
      EXTRA+=(--grid-distance "${2:?--grid-distance requires a value}")
      shift 2
      ;;
    --global-light)
      EXTRA+=(--global-light)
      shift
      ;;
    --no-lights)
      EXTRA+=(--no-lights)
      shift
      ;;
    -*)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$SPEC" ]]; then
        SPEC="$1"
      elif [[ -z "$SLUG" ]]; then
        SLUG="$1"
      else
        echo "Error: unexpected extra argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$SPEC" || -z "$SLUG" ]]; then
  echo "Usage: map-to-scene.sh <spec.json> <slug> --outdir <dir> --background <src> [--scenes-dir <path>] [--grid-distance N] [--global-light]" >&2
  exit 1
fi
if [[ ! -f "$SPEC" ]]; then
  echo "Error: spec not found: $SPEC" >&2
  exit 1
fi
if [[ -z "$OUTDIR" ]]; then
  echo "Error: --outdir is required (where render_map writes the PNGs + .dd2vtt)" >&2
  exit 1
fi
if [[ -z "$BACKGROUND" ]]; then
  echo "Error: --background is required (Foundry Data-relative path to the Player PNG)" >&2
  exit 1
fi

# Scene name = spec "name" (default "Map") unless overridden — must match the
# filenames render_map.py derives.
if [[ -z "$NAME" ]]; then
  NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name","Map"))' "$SPEC")"
fi

if [[ -n "$SCENES_DIR_OVERRIDE" ]]; then
  # Vault-hosted game: sources live beside the Obsidian notes, not in this repo.
  SCENES_DIR="$SCENES_DIR_OVERRIDE"
else
  SCENES_DIR="$REPO_ROOT/content/src-$SLUG/scenes"
  if [[ ! -f "$REPO_ROOT/content/$SLUG.config.json" ]]; then
    echo "Warning: content/$SLUG.config.json not found — run scripts/content/new-game.sh $SLUG first to create the module." >&2
  fi
fi
mkdir -p "$SCENES_DIR"

# Source filenames must be kebab-case: build.mjs derives each document's
# compendium _id from the path, so "Bandit Hideout.json" and a later renamed
# "bandit-hideout.json" import as two different documents. The scene's display
# name keeps the spec's spelling; only the filename is slugified.
SLUG_NAME="$(printf '%s' "$NAME" |
  tr '[:upper:]' '[:lower:]' |
  sed -e "s/['\`]//g" -e 's/[^a-z0-9]\+/-/g' -e 's/^-\+//' -e 's/-\+$//')"

python3 "$REPO_ROOT/scripts/maps/render_map.py" "$SPEC" "$OUTDIR"

node "$REPO_ROOT/scripts/content/dd2vtt-to-scene.mjs" "$OUTDIR/$NAME.dd2vtt" \
  --background "$BACKGROUND" \
  --out "$SCENES_DIR/$SLUG_NAME.json" \
  --name "$NAME" \
  "${EXTRA[@]}"

echo
echo "Scene written to $SCENES_DIR/$SLUG_NAME.json"
echo "Make sure the Player PNG lives under the Foundry data dir at: $BACKGROUND"
echo "Then build + sync + import:"
if [[ -n "$SCENES_DIR_OVERRIDE" ]]; then
  echo "  node scripts/content/build.mjs --config <path>/$SLUG.config.json --src $(dirname "$SCENES_DIR")"
  echo "  ./scripts/content/sync-content.sh --config <path>/$SLUG.config.json   # on the host"
else
  echo "  node scripts/content/build.mjs --config content/$SLUG.config.json"
  echo "  ./scripts/content/sync-content.sh --config content/$SLUG.config.json   # on the host"
fi
