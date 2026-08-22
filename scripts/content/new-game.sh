#!/usr/bin/env bash
# Scaffold a new game: the vault folder (notes + Foundry sources) or, with
# --in-repo, the older content/src-<slug>/ tree inside this repo.
#
# The scaffold IS the definition of done. Every note a finished game needs is
# created as a visibly-unfinished stub, because a missing file is noticeable in
# Obsidian and a missing paragraph in a doc is not.
#
# Usage: scripts/content/new-game.sh <slug> [--type oneshot|campaign] [--system <sys>]
#                                           [--title "<Title>"] [--vault <path>] [--in-repo]
#   <slug>     required; kebab-case game name (e.g. harborwatch). Module id = <slug>-<type>.
#   --type     oneshot (default) or campaign
#   --system   game system (dnd5e, cairn, ...); omit for a system-agnostic module
#   --title    display title / pack label prefix; default is the Title-Cased slug
#   --vault    vault root; default $DND_VAULT_PATH, else $HOME/DnD
#   --in-repo  legacy: scaffold content/<slug>.config.json + content/src-<slug>/ instead
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SLUG=""
TYPE="oneshot"
SYSTEM=""
TITLE=""
VAULT=""
IN_REPO=0

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
    --vault)
      VAULT="${2:?--vault requires a path}"
      shift 2
      ;;
    --in-repo)
      IN_REPO=1
      shift
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
  echo "Error: slug is required. Usage: new-game.sh <slug> [--type oneshot|campaign] [--system <sys>] [--title \"<Title>\"] [--vault <path>] [--in-repo]" >&2
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

# Optional "system" line — omitted entirely for a system-agnostic module.
SYSTEM_LINE=""
if [[ -n "$SYSTEM" ]]; then
  SYSTEM_LINE="  \"system\": \"$SYSTEM\","
fi
SYSTEM_FM="${SYSTEM:-agnostic}"

# --------------------------------------------------------------------------- #
# Legacy: everything inside this repo.
# --------------------------------------------------------------------------- #
if [[ "$IN_REPO" -eq 1 ]]; then
  SRC_DIR="src-$SLUG"
  CONFIG_FILE="$REPO_ROOT/content/$SLUG.config.json"
  SRC_ROOT="$REPO_ROOT/content/$SRC_DIR"

  if [[ -e "$CONFIG_FILE" ]]; then
    echo "Error: $CONFIG_FILE already exists — refusing to overwrite." >&2
    exit 1
  fi

  cat > "$CONFIG_FILE" << EOF
{
  "id": "$ID",
  "title": "$TITLE",
$SYSTEM_LINE
  "srcDir": "$SRC_DIR",
  "version": "1.0.0",
  "packLabelPrefix": "$TITLE",
  "compatibility": { "minimum": "12", "verified": "14" },
  "ownership": { "PLAYER": "OBSERVER", "ASSISTANT": "OWNER" }
}
EOF

  for type in actors items journals scenes tables; do
    mkdir -p "$SRC_ROOT/$type"
    touch "$SRC_ROOT/$type/.gitkeep"
  done

  echo "Scaffolded module $ID (in-repo)"
  echo "  config:  content/$SLUG.config.json"
  echo "  sources: content/$SRC_DIR/{actors,items,journals,scenes,tables}/"
  echo
  echo "Next: author cards into content/$SRC_DIR/, then build + sync:"
  echo "  node scripts/content/build.mjs --config content/$SLUG.config.json"
  echo "  ./scripts/content/sync-content.sh --config content/$SLUG.config.json   # on the host"
  exit 0
fi

# --------------------------------------------------------------------------- #
# Default: the game lives in the vault; this repo stays the pipeline.
# --------------------------------------------------------------------------- #
if [[ -z "$VAULT" ]]; then
  for candidate in "${DND_VAULT_PATH:-}" "$HOME/DnD" "$REPO_ROOT/DnD"; do
    if [[ -n "$candidate" && -d "$candidate" ]]; then
      VAULT="$candidate"
      break
    fi
  done
fi
if [[ -z "$VAULT" || ! -d "$VAULT" ]]; then
  echo "Error: no vault found. Pass --vault <path> or set DND_VAULT_PATH to the Obsidian vault root." >&2
  exit 1
fi

if [[ "$TYPE" == "campaign" ]]; then
  SECTION="02 Campaigns"
else
  SECTION="03 Oneshots"
fi
GAME_DIR="$VAULT/$SECTION/$TITLE"

if [[ -e "$GAME_DIR" ]]; then
  echo "Error: $GAME_DIR already exists — refusing to overwrite." >&2
  exit 1
fi

mkdir -p "$GAME_DIR"/{Handouts,Maps,NPCs,Scenes,Tables}
# Maps: render_map.py output. Tokens: custom token art for named NPCs, pointed
# at by `image:` in a statblock fence. Art: full illustrations you show players
# (SRD ships token art only, and it does not enlarge well).
mkdir -p "$GAME_DIR/Assets"/{Maps,Tokens,Art}
mkdir -p "$GAME_DIR/Foundry/maps"
for type in actors items journals scenes tables; do
  mkdir -p "$GAME_DIR/Foundry/src/$type"
done

# The module config. No "srcDir": that key resolves under content/ in this repo
# and would silently point at the wrong tree — build with --src instead.
cat > "$GAME_DIR/Foundry/$SLUG.config.json" << EOF
{
  "id": "$ID",
  "title": "$TITLE",
$SYSTEM_LINE
  "version": "1.0.0",
  "packLabelPrefix": "$TITLE",
  "compatibility": { "minimum": "12", "verified": "14" },
  "ownership": { "PLAYER": "OBSERVER", "ASSISTANT": "OWNER" }
}
EOF

TAG="$SLUG"

cat > "$GAME_DIR/$TITLE.md" << EOF
---
title: $TITLE
type: $TYPE
system: $SYSTEM_FM
level: REPLACE
players: REPLACE
runtime: REPLACE
themes: [REPLACE]
foundry_module: $ID
tags: [$SYSTEM_FM, $TYPE, $TAG]
---

# $TITLE

REPLACE — one paragraph: the pitch, the cast, the choice at the end.

> [!abstract] Premise
> REPLACE — two sentences, player-facing.

## Run order

1. **[[1 - REPLACE]]** — REPLACE
2. **[[2 - REPLACE]]** — REPLACE

## GM shelf

- [[GM Prep]] · [[Soundtrack]] · Handouts: REPLACE · Tables: REPLACE · Maps: REPLACE
- Cast: REPLACE
- Recruiting: [[Advert]]

## Cast & scenes (auto)

\`\`\`dataview
TABLE role, cr FROM "$SECTION/$TITLE/NPCs" WHERE type = "npc" SORT file.name
\`\`\`
\`\`\`dataview
TABLE scene FROM "$SECTION/$TITLE/Scenes" SORT scene, act, file.name
\`\`\`

## Foundry

Module **\`$ID\`**. Sources live in \`Foundry/\`, not in the pipeline repo.

\`\`\`bash
node scripts/content/build.mjs \\
  --config "$GAME_DIR/Foundry/$SLUG.config.json" \\
  --src    "$GAME_DIR/Foundry/src"
./scripts/content/sync-content.sh --config "<same>"   # on the host
docker compose restart
\`\`\`

## Tone

REPLACE
EOF

cat > "$GAME_DIR/GM Prep.md" << EOF
---
type: session
system: $SYSTEM_FM
artifact: [in-person, foundry]
tags: [$SYSTEM_FM, $TYPE, $TAG, gm]
---

# GM Prep — $TITLE

Back to [[$TITLE]].

## The truth (GM only)

REPLACE — what is actually going on, including anything the players are wrong about.

## Arc

1. REPLACE
2. REPLACE

## Pacing

REPLACE — minutes per scene, and which scene to cut if you run long.

## Run it well

- REPLACE — the one thing that makes this session land.

## Safety

REPLACE — anything worth checking at session zero.

## Scaling

**Easier:** REPLACE
**Harder:** REPLACE

## Rewards

REPLACE
EOF

cat > "$GAME_DIR/Soundtrack.md" << EOF
---
type: soundtrack
system: $SYSTEM_FM
artifact: [online, in-person]
tags: [$SYSTEM_FM, $TYPE, $TAG, audio]
---

# $TITLE — Soundtrack

Ambience plays **outside Foundry** — through Discord when you are online, and in
the room when you are not. Foundry serves no audio, so nothing here is streamed
to your players over the same connection carrying the game, and the same cue
sheet works at a physical table where Foundry is not running at all.

## Cue sheet (auto)

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS Scene,
  audio_source AS Source,
  audio_ref AS Play,
  audio_cue AS "Bring it in when"
FROM "$SECTION/$TITLE/Scenes"
SORT scene, act, file.name
\`\`\`

## Adding a cue

The cue lives on the scene note, not in a list here, so it cannot drift from the
scene it belongs to. Add three keys to that note's frontmatter:

\`\`\`yaml
audio_source: tabletopaudio   # tabletopaudio | spotify | local
audio_ref: https://tabletopaudio.com/...   # or a filename under 06 Assets/Audio/
audio_cue: as the boat leaves the jetty
\`\`\`

A scene with no cue shows blank in the table above — that is a to-do, not an
error. Silence is a legitimate choice; write \`audio_source: none\` when it is
deliberate, so you can tell the two apart at a glance.

## What plays it

Whatever you already use — a Discord music bot, Spotify shared into voice, or a
local player. The sheet gives you the link, not a command to paste: bot syntax
changes, and a cue sheet printing the wrong command is worse than one printing
a link.

Local clips live in \`06 Assets/Audio/\`, shared across games the way
\`06 Assets/Tokens/\` is.

> [!warning] Do not build Foundry playlists from these
> The vault is mounted inside Foundry's data root, so Foundry **can** see files
> in \`06 Assets/Audio/\`. Resist it. Every file in a Foundry playlist is streamed
> by your server to every connected client, and it does nothing for the sessions
> you run in person.
EOF

if [[ "$TYPE" == "oneshot" ]]; then
  cat > "$GAME_DIR/Advert.md" << EOF
---
type: handout
system: $SYSTEM_FM
artifact: [online]
player_visible: true
tags: [$SYSTEM_FM, $TYPE, $TAG, advert]
---

# $TITLE — Level REPLACE One-Shot

*(0/REPLACE slots filled)*

\`\`\`
**Premise:**
REPLACE — 2-3 sentences, player-facing. No villain names, no reveals.

**Slots:**
REPLACE players

**Systems/Rules:**
- D&D 5e (PHB 2024) - Level REPLACE Party
- Point Buy Array
- Any Class/Race

**Tone:**
REPLACE — tags • separated • by • bullets

**Length:**
Max ~REPLACE hours

**Tools:**
Discord VC, D&D Beyond & FoundryVTT (links will be provided)

**AI:**
Tokens for my own custom NPCs are AI-drawn where no stock art exists for them,
and my prep writing is AI-assisted — never in place of a paid artist and never
at the table itself; the full detail is pinned in the server, and plain tokens
are yours for the asking.
\`\`\`

## Playstyle & expectations

*GM-facing. Not part of the paste block.*

- REPLACE

## Scheduling

- **When:** REPLACE (GroupFlows poll).
- **Where:** Discord VC + FoundryVTT link, sent on the day.
EOF
fi

for dir in Handouts Maps NPCs Scenes Tables; do
  cat > "$GAME_DIR/$dir/.gitkeep" << EOF
EOF
done

echo "Scaffolded $TYPE \"$TITLE\" ($ID)"
echo "  game:    $GAME_DIR"
echo "  notes:   $TITLE.md, GM Prep.md, Soundtrack.md$([[ "$TYPE" == "oneshot" ]] && echo ", Advert.md")"
echo "  folders: Handouts/ Maps/ NPCs/ Scenes/ Tables/ Assets/{Maps,Tokens,Art}/"
echo "  foundry: Foundry/$SLUG.config.json + Foundry/src/{actors,items,journals,scenes,tables}/"
echo
echo "Definition of done — a finished game has ALL of these:"
todo() { printf '  [ ] %-18s %s\n' "$1" "$2"; }
todo "$TITLE.md" "index: premise, run order, GM shelf, dataview blocks"
todo "GM Prep.md" "the truth, arc, pacing, scaling, safety, rewards"
todo "NPCs/" "one card per creature, each with a statblock block"
todo "Scenes/" "one note per scene: read-aloud, map embed, beats"
todo "Soundtrack.md" "a cue per scene: audio_source/audio_ref/audio_cue"
todo "Tables/" "rumour/loot tables as markdown tables"
todo "Handouts/" "anything the players physically receive"
todo "Maps/" "map briefs or generator specs"
if [[ "$TYPE" == "oneshot" ]]; then
  todo "Advert.md" "GroupFlows recruitment post (online games)"
fi
todo "Foundry/src/" "the above projected to JSON, ONCE, at packaging"
echo
echo "Author the vault notes FIRST — they are the source of truth. The Foundry"
echo "JSON is a projection of them; never hand-maintain both."
echo
echo "Then build:"
echo "  node scripts/content/build.mjs --config \"$GAME_DIR/Foundry/$SLUG.config.json\" --src \"$GAME_DIR/Foundry/src\""
