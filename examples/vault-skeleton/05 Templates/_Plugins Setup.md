---
title: Plugins Setup
tags: [ttrpg, reference, meta]
---

# Plugins Setup

How the vault uses the enabled plugins. Do the one-time settings below, then the
templates/indexes just work.

## Templater
- **Settings → Templater → Template folder location:** `05 Templates`.
- **Trigger Templater on new file creation:** ON (so `<% tp.* %>` fills in).
- **Folder Templates** (auto-apply a template by where you create the note):
  | Folder | Template |
  |---|---|
  | `…/NPCs` | `NPC Template` |
  | `…/Locations` | `Location Template` |
  | `…/Factions` | `Faction Template` |
  | `…/Items` | `Item Template` |
  | `…/Quests` | `Quest Template` |
  | `…/Sessions` | `Session Template` |
- Or bind a hotkey to **"Templater: Create new note from template."**

## Dataview
- **Settings → Dataview → Enable JavaScript Queries:** optional (the indexes use
  plain DQL, no JS needed).
- The Home MOC and each oneshot index carry auto-index `dataview` blocks — they
  populate from note `type`/`tags` frontmatter, so **fill the frontmatter and the
  lists build themselves.**

## Fantasy Statblocks
- NPC cards already contain a ```` ```statblock ```` block (see `NPC Template`).
  It renders a printable stat card.
- To reference a monster by name (`monster: Goblin`) instead of inlining, import
  a bestiary (SRD / homebrew) in the plugin settings, then **Rebuild** the index.

## Initiative Tracker
- Reads Fantasy Statblocks creatures. In an encounter, add combatants by their
  statblock `name`.

## Leaflet (interactive image maps)
Use instead of a flat `![[map.png]]` when you want pins/measuring. Example:
````markdown
```leaflet
id: dungeon-map
image: [[dungeon-map.png]]
height: 500px
lat: 50
long: 50
minZoom: 1
maxZoom: 5
defaultZoom: 2
unit: ft
scale: 5
```
````

## Buttons (trigger templates)
Put a button in a MOC to spawn a new card via Templater. Example — a "New NPC"
button:
````markdown
```button
name New NPC
type note(NPCs/Untitled) template
action NPC Template
```
````
(Requires the **Buttons** + **Templater** integration; set the Templater folder
above first.)
