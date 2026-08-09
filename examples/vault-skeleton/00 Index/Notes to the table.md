---
title: Notes to the table
tags: [ttrpg, moc, process, reference]
---

# Notes to the table

How prep in this vault reaches an actual game — **in person** or **online (FoundryVTT)**.
Same notes, two surfaces. This is the **artifact split** on every card
(`artifact: [in-person, foundry]`): the vault serves the table directly, and Foundry is
just *one more consumer* of the same source.

> [!abstract] Principle
> **Obsidian + the git content module + D&D Beyond hold all durable truth. Foundry is a
> transient container** — wipe and rebuild it anytime; nothing important lives only there.

## In person — no export needed

Run straight from the vault (laptop/tablet = your GM screen):

| Need | Served by |
|---|---|
| GM screen / navigation | the vault — Dataview indexes + `[[wikilinks]]` |
| Statblocks | **Fantasy Statblocks** cards (render/print in Obsidian) |
| Handouts | `type: handout` notes — print or show on a device |
| Maps | DungeonMapBuilder **print PNG/PDF**, printable map/token PDFs, or display on a TV |
| Combat | dice + optional **Initiative Tracker** on a tablet |

Nothing in the Foundry pipeline below is required at a physical table.

## Online / hybrid — into FoundryVTT

Route by content type — no single tool does it all:

| Content | Pipe | Direction |
|---|---|---|
| Notes / journals / handouts | **SoSly Obsidian Bridge** (Foundry module) | **bidirectional** |
| NPCs / items / roll tables / scenes | **content-as-code → compendium module** | one-way (git = truth) |
| Images / art / map files | **shared vault mount** | shared files (no copy) |
| Maps as walled/lit Scenes | **DungeonMapBuilder `.dd2vtt` → Universal Battlemap Importer** (`dd-import`) | source `.dd2vtt` lives in the vault |
| Player characters | **D&D Beyond → ddb-importer** | DDB = truth |

**Durable:** vault (prose, assets, map `.dd2vtt`), git content module, D&D Beyond.
**Transient (fine to lose):** token positions, fog, combat tracker, the active scene.

The shared vault mount is the backbone — it shows assets in Foundry's file picker *and*
lets the SoSly bridge read the vault from Foundry's filesystem.

### Rebuild Foundry from scratch (proves it's transient)
1. Fresh / wiped world.
2. Enable the **content compendium module** → NPCs / items / tables back.
3. **SoSly bridge** import → vault notes become journals (stays bidirectional).
4. **Universal Battlemap Importer** on the vault `.dd2vtt` → scenes with walls + lights.
5. **ddb-importer** → player characters. Assets resolve via the mount.

## Bring a game into Foundry (per-game checklist)

Works for any **oneshot** (`03 Oneshots/<Game>/`) or **campaign** (`02 Campaigns/<Game>/`).
One-time: install the 3 modules (below) and confirm the shared vault mount. All steps
run on the **host**.

1. **Content → compendium** (statted NPCs, items, journals, roll tables). In the repo, on the
   branch holding this game's content:
   ```bash
   node scripts/content/build.mjs    --config content/<game>.config.json
   ./scripts/content/sync-content.sh --config content/<game>.config.json
   ```
   Foundry → **Manage Modules → enable the game's module → Compendium Packs → import**.
2. **Notes → SoSly bridge.** Point the bridge at your vault's
   `<03 Oneshots|02 Campaigns>/<Game>/` folder → **Import** → journals (bidirectional).
3. **Maps → scenes.** Scenes → **Universal Battlemap import** → each
   `…/<Game>/Assets/Maps/*.dd2vtt` → a walled/lit scene (clean player-map background; keep the
   `- DM` map for your screen).
4. **Player PCs → ddb-importer** from D&D Beyond.

Assets resolve through the mount — nothing is copied into the world. Wipe the world and repeat
to rebuild (see the rebuild recipe above).

## Maps

Note → **Map Brief** ([[Map Brief Template]]) → **default:** Claude runs the generator
(`scripts/maps/render_map.py`) → **two maps + a `.dd2vtt`**:
- **`<name> - Player.png`** — clean; embedded in the location note / shown to players.
- **`<name> - DM.png`** — numbered key + hazard/secret notes; GM-only.
- **`<name>.dd2vtt`** — Foundry scene (walls + lights) via Universal Battlemap Importer.
Print either for in-person. For **painted art**, build in **DungeonMapBuilder** (or Dungeon
Scrawl / Watabou / AI) and drop it in `Assets/Maps/` to replace the generated background.

## Foundry-side modules (install once)
- **SoSly Obsidian Bridge** — journals ↔ Obsidian, bidirectional.
- **Universal Battlemap Importer** (`dd-import`) — `.dd2vtt` → scenes with walls/lights.
- **ddb-importer** — D&D Beyond characters → Foundry.
- Your **content compendium module(s)** — built from `content/src/` in the repo.

## Watch out
- **One writer at a time now spans Foundry** — don't edit the same journal in Foundry and
  Obsidian at once (bridge + Sync can clobber). Obsidian is primary.
- **A journal goes via the bridge OR the compendium pipeline, never both.**
- Foundry image links resolve against the shared vault mount — keep that mount path stable.

Back to [[Home]] · see also [[How this vault works]] · [[Running a new game]].
