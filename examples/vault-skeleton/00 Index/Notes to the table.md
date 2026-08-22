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
> That was drilled end to end on 2026-08-21 rather than assumed — see below.

## In person — no export needed

Run straight from the vault (laptop/tablet = your GM screen):

| Need | Served by |
|---|---|
| GM screen / navigation | the vault — Dataview indexes + `[[wikilinks]]` |
| Statblocks | **Fantasy Statblocks** cards (render/print in Obsidian) — the same fence the Foundry actor is compiled from |
| Handouts | `type: handout` notes — print or show on a device |
| Maps | DungeonMapBuilder **print PNG/PDF**, printable map/token PDFs, or display on a TV |
| Combat | dice + optional **Initiative Tracker** on a tablet |

Nothing in the Foundry pipeline below is required at a physical table.

## Online / hybrid — into FoundryVTT

Route by content type — no single tool does it all:

| Content | Pipe | Direction |
|---|---|---|
| Notes / journals / handouts | **SoSly Obsidian Bridge** (Foundry module) | **bidirectional** |
| NPCs / items / roll tables / scenes | **content-as-code → compendium module** | one-way (the vault note is truth) |
| Images / art / map files | **shared vault mount** | shared files (no copy) |
| Maps as walled/lit Scenes | **DungeonMapBuilder `.dd2vtt` → Universal Battlemap Importer** (`dd-import`) | source `.dd2vtt` lives in the vault |
| Player characters | **D&D Beyond → ddb-importer** | DDB = truth |

**Durable:** vault (prose, assets, map `.dd2vtt`), git content module, D&D Beyond.
**Transient (fine to lose):** token positions, fog, combat tracker, the active scene.

The shared vault mount is the backbone — it shows assets in Foundry's file picker *and*
lets the SoSly bridge read the vault from Foundry's filesystem.

### Rebuild Foundry from scratch (drilled, not theoretical)

Tested the hard way on 2026-08-21: the whole install was wiped and built back. Budget
**15–30 minutes** once it runs clean — most of that is Foundry downloading itself. Two levels
come back from two different places.

**The install** — Foundry, the game system, the module set — from the repo's golden base
(`foundry-base.json`, everything pinned):

```bash
node scripts/content/foundry-base.mjs provision      # pinned system + core modules
node scripts/content/foundry-base.mjs new-world <slug> --title "<Title>"
node scripts/content/foundry-base.mjs pull-games     # each game's module, rebuilt from this vault
node scripts/content/foundry-base.mjs verify         # the gate — non-zero if anything is off
```

`new-world` applies a captured settings template, so the world opens **configured** rather than
blank, and `verify` is what makes "it came back" a fact instead of a feeling.

**The content** — from this vault, plus D&D Beyond:

1. Enable the game's **content compendium module** → import NPCs / items / tables with
   **Keep Document IDs** ticked.
2. **SoSly bridge** import → notes become journals (stays bidirectional).
3. **Universal Battlemap Importer** on the game's `.dd2vtt` → scenes with walls + lights.
4. **ddb-importer** re-munch → player characters. Its `world.ddb-*` packs are world-scoped, so
   they die with every world and this step comes round every time.

Assets resolve through the vault mount — nothing was ever copied into the world.

> [!warning] Stop Foundry first, and refresh the download link before wiping
> Anything that reads a world's database needs Foundry **stopped**; the errors look like
> corruption rather than a lock. And Foundry's installer URL is presigned and **expires** —
> refresh it *before* the wipe, or the rebuild stops dead at a 403 with nothing to install.

> [!tip] With a full snapshot, most of the content steps are free
> `foundry-base.mjs snapshot` (full mode, worlds included), taken between sessions, turns steps
> 1–4 into copying one world folder back into place — then `pull-games`, which is still
> required, because the world holds the documents but not the module they came from. Don't reach
> for `restore --yes` to recover a single world; it replaces the entire data directory.

The full drill — every step, what it costs, and what a settings template deliberately does *not*
carry — is `docs/FOUNDRY_REBUILD.md` in the repo.

## Bring a game into Foundry (per-game checklist)

Works for any **oneshot** (`03 Oneshots/<Game>/`) or **campaign** (`02 Campaigns/<Game>/`).
One-time: install the 3 modules (below) and confirm the shared vault mount. All steps
run on the **host**.

1. **Content → compendium** (statted NPCs, items, journals, roll tables). The sources live
   with the game, in the vault; the repo only builds them:
   ```bash
   G="<vault>/03 Oneshots/<Game>/Foundry"
   node scripts/content/build.mjs    --config "$G/<slug>.config.json" --src "$G/src"
   ./scripts/content/sync-content.sh --config "$G/<slug>.config.json"
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
- **`<name> - Player.webp`** — clean; embedded in the location note / shown to players.
- **`<name> - DM.webp`** — numbered key + hazard/secret notes; GM-only.
- **`<name>.dd2vtt`** — Foundry scene (walls + lights) via Universal Battlemap Importer.
Print either for in-person. For **painted art**, build in **DungeonMapBuilder** (or Dungeon
Scrawl / Watabou / AI) and drop it in `Assets/Maps/` to replace the generated background.
An AI-generated map has to be disclosed to players — see [[AI disclosure]].

## Foundry-side modules (install once)
- **SoSly Obsidian Bridge** — journals ↔ Obsidian, bidirectional.
- **Universal Battlemap Importer** (`dd-import`) — `.dd2vtt` → scenes with walls/lights.
- **ddb-importer** — D&D Beyond characters → Foundry.
- Your **content compendium module(s)** — one per game, built from that game's
  `Foundry/src/` beside its notes.

## Watch out
- **One writer at a time now spans Foundry** — don't edit the same journal in Foundry and
  Obsidian at once (bridge + Sync can clobber). Obsidian is primary.
- **A journal goes via the bridge OR the compendium pipeline, never both.**
- Foundry image links resolve against the shared vault mount — keep that mount path stable.

Back to [[Home]] · see also [[How this vault works]] · [[Running a new game]].
