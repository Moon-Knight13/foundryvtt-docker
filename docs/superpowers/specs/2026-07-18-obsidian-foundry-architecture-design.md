# Obsidian ↔ Foundry architecture — design spec

Status: **design; tooling landed incrementally.** The reverse of "Foundry is the
home": **Obsidian (+ the git content module + D&D Beyond) hold all durable truth,
and FoundryVTT is a transient, rebuildable container.**

## Context

The GM authors prep in an Obsidian vault (system-agnostic notes, cards, assets).
The same prep must serve **in-person, online, and hybrid** play. FoundryVTT is a
Docker container that can be rebuilt at any time, so nothing important may live
only in its world DB. This spec defines how notes/objects/maps/PCs reach a table
or a Foundry world, and how a wiped world is rebuilt from durable sources.

## Durable vs transient

- **Durable:** the Obsidian vault (`~/Documents/DnD`, bind-mounted into the
  Foundry container at `/data/Data/DnD`); the git content-as-code module(s)
  (`content/src/*.json` → compendium); D&D Beyond (player characters).
- **Transient (fine to lose on rebuild):** Foundry world state — token positions,
  fog, combat tracker, the active scene.

## Two play surfaces (the artifact split)

Every card carries `artifact: [in-person, foundry]`. Neither surface is primary.

- **In person — no export.** Run straight from the vault: Dataview indexes +
  `[[wikilinks]]` as the GM screen; Fantasy Statblocks cards; `handout` notes
  printed or shown; DungeonMapBuilder print PNG/PDF (or a TV); dice + Initiative
  Tracker.
- **Online / hybrid — into Foundry** via the pipes below.

## Pipes (route by content type)

| Content | Pipe | Direction |
|---|---|---|
| Notes / journals / handouts | **SoSly Obsidian Bridge** (Foundry module) | bidirectional |
| NPCs / items / roll tables / scenes | **content-as-code → compendium module** | one-way (git = truth) |
| Images / art / map files | **`/data/Data/DnD` mount** | shared (no copy) |
| Maps as walled/lit scenes | **DungeonMapBuilder `.dd2vtt` → Universal Battlemap Importer** (`dd-import`) | source `.dd2vtt` in vault |
| Player characters | **D&D Beyond → ddb-importer** | DDB = truth |

The `/data/Data/DnD` mount is the backbone: it exposes vault assets to Foundry's
file picker **and** lets the SoSly bridge read the vault from Foundry's
filesystem.

## Map-making workflow (Claude-assisted)

Note → Claude drafts a **Map Brief** (grid, rooms = keyed areas, doors, features,
lighting) → user builds in **DungeonMapBuilder** → export **`.dd2vtt`** (Foundry,
walls/lights) or **PNG/PDF** (in-person) → drop in `<game>/Assets/Maps/` → Claude
embeds it in the location note. (Deferred/optional: a `.dd2vtt` packer to wrap a
plain PNG from Dungeon Scrawl / Watabou / AI into a walled scene; a greybox
generator.)

## Tooling delivered

- **Multi-module content build** — `scripts/content/build.mjs` and
  `sync-content.sh` accept `--config <path>`; source root resolves explicit-arg >
  config `srcDir` > `content/src` (`resolveSrcRoot`, unit-tested). One repo builds
  N compendium modules (per campaign/oneshot).
- **Scenes as code** — `content/src/scenes/*.json` with `background.src` pointing
  at a mounted vault image (`CONTENT_AUTHORING.md`).
- **Rebuild recipe** — `FOUNDRY_REBUILD.md` (module list + 5-step rebuild + an
  optional world setup macro).

## Rebuild recipe (proves transience)

Fresh world → enable content compendium (objects) → SoSly bridge import (notes,
bidirectional) → Universal Battlemap Importer on vault `.dd2vtt` (scenes) →
ddb-importer (PCs). Assets resolve via the mount. See `FOUNDRY_REBUILD.md`.

## Risks / guardrails

- Bidirectional sync is a new conflict surface — one-writer now spans Foundry.
- A journal is owned by one pipe (bridge OR compendium), never both.
- `.dd2vtt` import is primary over scene-JSON for walls/lights.
- Foundry image refs resolve against `/data/Data/DnD` — keep the mount path stable.
- Automation ceiling: notes are auto + two-way; content build is one-command but
  the Foundry-side import is manual clicks unless a macro scripts it.

## Out of scope

- The `.dd2vtt` packer / greybox generator (deferred; DungeonMapBuilder native
  export is the primary map path).
- The always-on-host / Cloudflare-tunnel operational overhaul (separate; this
  architecture is its prerequisite).
