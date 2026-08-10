---
title: Running a new game
tags: [ttrpg, moc, process]
---

# Running a new game

Your launchpad. Turn any spark — an idea, a source, rough notes, an image, or
just "I need an encounter" — into **table-ready vault notes** (and optional
**Foundry content**). Pick a lane below.

## Workflow

```mermaid
flowchart TD
  A([Spark: a game or a piece]) --> B{What do you have?}
  B -->|Just an idea| C[Conversation: 'new oneshot / campaign']
  B -->|A source + pages| D[Reference: 'build from PDF p.X to Y']
  B -->|Your rough notes| E[Drop in 99 Inbox, say 'tidy these']
  B -->|An image / map| F[Say 'key this map']
  B -->|Need one piece| G[Encounter / NPC / table / handout]
  C --> H[Claude fills a Game Brief]
  D --> H
  H --> I[Claude scaffolds folder + cards]
  E --> I
  F --> I
  G --> I
  I --> J[Review in Obsidian, refine]
  J --> K{Play online?}
  K -->|Yes| L[Compile Foundry artifacts]
  K -->|No| M[Print / run in person]
```

## Quick start — buttons

Spawn the starting card, then tell Claude to build it. *(Needs Buttons +
Templater configured — see [[_Plugins Setup]].)*

```button
name 🎲 New Game Brief
type note(99 Inbox/New Game Brief, split) template
action New Game Brief Template
templater true
```
```button
name ⚔️ New Encounter
type note(99 Inbox/New Encounter, split) template
action Encounter Template
templater true
```
```button
name 🧑 New NPC
type note(99 Inbox/New NPC, split) template
action NPC Template
templater true
```
```button
name 🎲 New Roll Table
type note(99 Inbox/New Roll Table, split) template
action Roll Table Template
templater true
```
```button
name 🗺️ New Map Brief
type note(99 Inbox/New Map Brief, split) template
action Map Brief Template
templater true
```

## Quick start — say it to Claude

Copy a line, fill the `<…>`, send it:

```text
new oneshot — dnd5e, 4 players, level <N>, ~3h, tone <…>. Interview me.
```
```text
build a oneshot from [[<a source PDF>]] p.<A>-<B>.
```
```text
tidy my rough notes in 99 Inbox/<name>/ into a oneshot.
```
```text
key this map: ![[<map>.png]] — rooms, features, an encounter or two.
```
```text
build an encounter: 4x level-<N> in <place>, <easy/medium/hard>.
```
```text
make a 1d8 <rumors/loot/complications> table for <game>.
```
```text
fill the statblock on [[<NPC>]] — around CR <X>, <flavour>.
```
```text
session recap: <what happened> — write the recap and prep next session.
```
```text
map for [[<location>]] — generate player + DM battlemaps (+ .dd2vtt) from the notes.
```

## Creation cases (catalog)

| You give | You get | Start with |
|---|---|---|
| An idea | Full game (interviewed) | "new oneshot/campaign" |
| A source + pages | Game built from it | "build from [[PDF]] p.X–Y" |
| Your rough notes | Tidied structured notes | "tidy 99 Inbox/…" |
| A map/image | Keyed location note | "key this map ![[…]]" |
| A location note | Player + DM battlemaps + `.dd2vtt` (generated) | "map for [[…]]" |
| A creature need | NPC / statblock card | "fill statblock" / "reskin SRD …" |
| Party + place | Balanced encounter | "encounter: 4× L4 in …" |
| A theme | Roll table / generator | "1d8 rumors table for …" |
| A prop idea | Player handout | "write the letter/notice/riddle …" |
| Post-session | Recap + next-session prep | "session recap: …" |
| Existing content | Reskin / scale / sequel | "scale <your game> to L5" |
| A concept | Faction / region / pantheon | "build the … faction" |
| A oneshot | Ready-to-run pregens | "make 5 L3 pregens" |
| Another system | Converted prep | "convert … to Cairn" |
| A loose pile | Cross-links + MOC | "link and index …" |

## The three build modes (detail)

- **Conversation** — Claude asks for system, level, players, runtime, tone,
  premise, structure, cast, locations, set-pieces, bespoke mechanics; fills a
  **[[New Game Brief Template|Game Brief]]**; confirms; builds.
- **Reference** — cite the note/PDF **and page numbers**; Claude reads those
  exact pages, drafts, and flags gaps. (External sites may need a paste.)
- **Your notes** — drop in `99 Inbox/<name>/`; Claude reshapes them (strip cruft,
  add frontmatter, split into cards).

## What Claude produces
A finished folder (`03 Oneshots/<Name>/` or `02 Campaigns/<Name>/`) in the house
style: index/MOC, GM prep, scene/POI notes, NPC cards (Fantasy Statblocks),
handouts, `Assets/`, Dataview auto-index.

## Package for Foundry (per game)
Author in the vault first — it's the durable truth. When a game is table-ready
**and** you're playing online, project it into Foundry. Foundry is a
**rebuildable** view: wipe the world, re-run these pipes, lose nothing.

Each game gets its **own** content module. One-time scaffold (in the devcontainer):

```text
scripts/content/new-game.sh <slug> --type oneshot|campaign [--system dnd5e]
```

Then run the pipes **in this order** (objects exist before notes/scenes link to them):

1. **Objects** — Claude ports the NPC statblocks / items / tables into
   `content/src-<slug>/`, then `build.mjs --config content/<slug>.config.json`,
   then on the host `sync-content.sh --config …`; in Foundry, enable **that
   game's** module and import its packs.
2. **Notes** — SoSly Obsidian Bridge import turns your prose notes into journals.
3. **Maps** — Universal Battlemap Importer on the `.dd2vtt` under `Assets/Maps/`
   builds scenes with walls + lights.
4. **PCs** — ddb-importer pulls each player character from D&D Beyond.

**One owner per document.** A creature's stats live *either* in the vault
statblock *or* in `content/src-<slug>/` — port once at packaging, then stop
hand-editing the other. A journal is carried by the Bridge (prose) *or* the
compendium (structured), never both. See
[[How this vault works#Foundry pipeline]] and `docs/FOUNDRY_REBUILD.md`.

## Play surfaces
- **In person** — vault only. No Foundry, no packaging. Fantasy Statblocks,
  Initiative Tracker, printed / TV maps. Zero Foundry/MCP token cost.
- **Online** — the Foundry projection; players join over the Cloudflare Tunnel.
- **Hybrid** — Foundry owns **live** state (tokens, initiative, fog); the vault
  stays prep-only. Don't edit the same journal in both at once.

## Editing a game later
Change the source, rebuild, re-import — in place:

```text
edit content/src-<slug>/…  ->  build --config …  ->  sync --config …  ->  re-import
```

- **Never rename a source file** — the compendium id derives from the path, so a
  rename makes a **duplicate** on re-import instead of updating.
- Re-import updates the **compendium copy only**. Anything already dragged into
  the world is a separate copy — fix those in the Foundry UI (or via foundry-mcp).

## Token-lean prep
- Scope to one game: point Claude at `03 Oneshots/<Name>/` (or the campaign
  folder) + `content/src-<slug>/`, not the whole vault.
- **Cite by `[[link]]` or page range**, never "read my vault" — Claude reads only
  what you cite. Navigate via MOCs / Dataview, not wholesale reads.
- In-person games cost zero Foundry/MCP tokens. Content-as-code (build + import)
  is far cheaper than live foundry-mcp content tools.

## The loop
Claude drafts → you review in Obsidian → say what to change → Claude refines.

Back to [[Home]].
