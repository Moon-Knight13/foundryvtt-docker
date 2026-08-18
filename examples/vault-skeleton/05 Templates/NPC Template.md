---
type: npc
system: dnd5e
artifact: [in-person, foundry]
foundry_pack: actors
disposition: hostile
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

> This block is the single source of truth for both surfaces. Fantasy Statblocks
> renders it as a printable card (the in-person artifact), and
> `scripts/content/statblock.mjs` compiles the **same** fields into the Foundry
> actor JSON. Never hand-maintain a second copy — edit here and recompile.
>
> The actor is named after **this note's filename**, so a card headed
> "Selyse (Lamia)" still becomes an actor called "Selyse".

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
source: SRD 5.1 (CC-BY-4.0) — REPLACE
```

### Keys the compiler reads

| Key | Effect |
| --- | --- |
| `source:` | Names the SRD base creature, e.g. `SRD 5.1 (CC-BY-4.0) — Spy`. Drives both art inheritance and the stat check. Drop it for a wholly original NPC. |
| `image:` | Portrait/token art. Omit it and the base creature's shipped art is inherited. Point it at a vault file (`DnD/<game>/Assets/Tokens/x.webp`) for a custom one. |
| `deviations:` | List of fields intentionally changed from the base, e.g. `[hp, ac]`. Silences those deltas so the *unintentional* ones stay visible. |
| `exact: true` | Any divergence from the base becomes an error instead of a warning. |
| `disposition:` | **Frontmatter, not the fence** — `hostile` (default), `neutral`, `friendly`. A Spy who starts the session as an ally is neutral. |

Bonuses are written as the stat block shows them (`insight: 5`), not as
proficiency multipliers. The compiler works out whether that means proficiency
or expertise from the ability score and CR, and warns when a number is not
reachable from either — which is usually a typo.

## Links

Campaign: [[ ]] · Location: [[ ]] · Faction: [[ ]]
