# Rebuilding FoundryVTT from durable sources

FoundryVTT is treated as a **transient container**. All durable truth lives
outside its world DB:

- **Obsidian vault** (`~/Documents/DnD`, bind-mounted into Foundry at
  `/data/Data/DnD`) — prose/notes, assets, map `.dd2vtt` files.
- **Git content module(s)** — `content/src/*.json` compiled to a compendium
  (see `CONTENT_AUTHORING.md`).
- **D&D Beyond** — player characters.

So a world can be wiped and rebuilt without losing anything unique. Only
**live-session state** (token positions, fog, combat tracker, the active scene)
lives in the world, and that is meant to be transient.

## Foundry-side modules (install once)

| Module | Role |
|---|---|
| **SoSly Obsidian Bridge** | journals ↔ Obsidian vault, **bidirectional** |
| **Universal Battlemap Importer** (`dd-import`, moo-man) | `.dd2vtt` → scenes with walls/lights/doors |
| **ddb-importer** | D&D Beyond characters → Foundry actors |
| your **content compendium module(s)** | built from `content/src/` (this repo) |

## Rebuild recipe

1. **Fresh / wiped world.**
2. **Objects:** enable the content compendium module(s) → NPCs / items / roll
   tables (and any scene stubs) are available. (Build+sync from the repo first:
   `node scripts/content/build.mjs [--config …]` then, on the host,
   `./scripts/content/sync-content.sh [--config …]`.)
3. **Notes:** run the SoSly Obsidian Bridge import → vault notes become Foundry
   journals. Leave it on for bidirectional sync (Foundry edits flow back to the
   vault).
4. **Maps:** for each map, Universal Battlemap Importer → point at the vault
   `.dd2vtt` (`/data/Data/DnD/<game>/Assets/Maps/…`) → a scene with walls + lights.
5. **Player characters:** ddb-importer → import each PC from D&D Beyond.

Assets (images/handouts) resolve automatically via the `/data/Data/DnD` mount —
nothing is copied into the world.

## Guardrails

- **One writer at a time now spans Foundry.** Do not edit the same journal in
  Foundry and Obsidian (or on two devices) at once — the bridge plus Obsidian
  Sync can clobber. Treat Obsidian as primary; let Foundry edits sync back, then
  stop.
- **A journal is owned by one pipe** — the bridge (prose) **or** the compendium
  build (structured), never both.
- **Keep the mount path stable** (`/data/Data/DnD`). Foundry scene/journal image
  references resolve against it; changing it breaks links on rebuild.

## Optional: a world "setup" macro

Most rebuild steps are UI clicks. A GM macro can collapse steps 2–3 (enable the
content module, import its packs, trigger a bridge sync) into one run. Left as a
per-world convenience; the recipe above is the source of truth.
