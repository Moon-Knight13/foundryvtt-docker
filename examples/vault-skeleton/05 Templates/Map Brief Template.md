---
type: map-brief
system: agnostic
artifact: [in-person, foundry]
location:
grid: 30x20        # width x height in squares
ppi: 70            # pixels per grid square (DMB default ~70-140)
created: <% tp.date.now("YYYY-MM-DD") %>
tags: [ttrpg, map-brief]
---

# <% tp.file.title %> — Map Brief

> Turns a location note into a buildable map spec so the map **matches the notes**.
> Fill it (or let Claude draft it from the location), then build in
> **DungeonMapBuilder** → export. See [[Notes to the table#Maps]].

**Location note:** [[ ]]
**Size:** REPLACE squares (e.g. 30×20) · **Scale:** 5 ft/square

## Rooms / areas
> One row per keyed area in the location note.

| Area | Size (sq) | Features | Doors / connects to |
|---|---|---|---|
| REPLACE | 6×6 | REPLACE | REPLACE |
| | | | |

## Lighting & atmosphere
- REPLACE — light sources, darkness, hazards, water/elevation.

## Output — default: two generated maps
Claude compiles this brief into a **map spec** and runs the generator:
```bash
python3 scripts/maps/render_map.py <spec>.json "<game>/Assets/Maps/"
```
→ **`<name> - Player.webp`** (clean, show players), **`<name> - DM.webp`** (numbered
key + hazard/secret notes, GM-only), and **`<name>.dd2vtt`** (Foundry walls + lights,
via **Universal Battlemap Importer**). Claude embeds the Player map in the location
note; the DM map stays a GM callout. Print either for in-person.

### Upgrade to painted art (optional)
For nicer visuals, build in **DungeonMapBuilder** (exports Foundry-ready `.dd2vtt`) —
or Dungeon Scrawl / Watabou / AI (PNG) — drop it in `Assets/Maps/`, and it replaces
the generated background in the same `.dd2vtt` slot.
