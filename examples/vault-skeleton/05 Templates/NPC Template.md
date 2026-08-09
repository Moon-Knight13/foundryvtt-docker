---
type: npc
system: dnd5e
artifact: [in-person, foundry]
foundry_pack: actors
cr:
role:
location:
created: <% tp.date.now("YYYY-MM-DD") %>
tags: [ttrpg, npc]
---

# <% tp.file.title %>

> One-line hook — who they are, what they want, why the party cares.

## Roleplay
- **Voice / manner:** REPLACE
- **Wants:** REPLACE
- **Secret:** REPLACE
- **Mechanical hook (in play):** REPLACE

## Statblock
> Fantasy Statblocks renders the block below as a printable card (in-person
> artifact). Claude compiles this same data into the Foundry actor JSON.

```statblock
name: <% tp.file.title %>
size: Medium
type: humanoid
alignment: Neutral
ac: 12
hp: 22
hit_dice: 4d8 + 4
speed: 30 ft.
stats: [11, 14, 12, 15, 16, 13]
saves:
  - wisdom: 4
skillsaves:
  - insight: 5
senses: passive Perception 13
languages: Common
cr: 1
traits:
  - name: REPLACE
    desc: REPLACE
actions:
  - name: REPLACE
    desc: REPLACE
```

## Links
Campaign: [[ ]] · Location: [[ ]] · Faction: [[ ]]
