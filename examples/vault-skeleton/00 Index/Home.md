---
title: Home
tags: [ttrpg, moc]
---

# TTRPG Vault — Home

The backbone for all your tabletop prep. One source of truth, playable in person,
online, or via FoundryVTT. See [[How this vault works]] for the card → artifact
model.

## Map of content

- **[[How this vault works]]** — cards, artifacts, the Foundry pipeline
- **[[Running a new game]]** — DM process: build a game by conversation, reference, or your own notes
- **[[Notes to the table]]** — get prep to the table: in-person + FoundryVTT (Foundry stays transient)
- **[[AI disclosure]]** — what in this prep is AI-generated imagery, and the line players get told
- **01 Systems** — rules refs & PDFs (dnd5e, cairn)
- **02 Campaigns** — ongoing games (one MOC each)
- **03 Oneshots** — self-contained games (one folder each)
- **04 Bestiary** — reusable creature statblocks
- **05 Templates** — card templates (NPC, Location, Faction, Item, Quest, Session, Handout)
- **06 Assets** — maps / handouts / tokens (also Foundry's file picker)
- **99 Inbox** — quick capture

## Quick links
- New NPC → copy `05 Templates/NPC Template`
- New session → copy `05 Templates/Session Template`
- Build Foundry content from a card → see [[How this vault works#Foundry pipeline]]
- Rebuild Foundry after a wipe → [[Notes to the table#Rebuild Foundry from scratch (drilled, not theoretical)]]

## Oneshots (auto)
```dataview
TABLE system, level, runtime FROM "03 Oneshots" WHERE type = "oneshot" SORT file.name
```

## Campaigns (auto)
```dataview
TABLE system FROM "02 Campaigns" WHERE type = "campaign" SORT file.name
```

## Recently touched
```dataview
TABLE file.mtime AS "Modified" FROM "" WHERE contains(tags, "ttrpg") AND !contains(file.folder, "05 Templates") SORT file.mtime DESC LIMIT 12
```
