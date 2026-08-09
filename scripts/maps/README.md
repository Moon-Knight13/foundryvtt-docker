# Spec-driven battlemap generator

`render_map.py` turns one JSON layout spec into three artifacts: a clean
**Player** map, a keyed **DM** map, and a Foundry-ready **Universal VTT**
(`.dd2vtt`) with walls, lights and portals baked in. It is a generalization of
a one-off Pillow script (the belfry), turned into a reusable tool.

## CLI

```bash
python3 scripts/maps/render_map.py <spec.json> <outdir>
```

Writes into `<outdir>` (using the spec's `name`):

| File | Contents |
|---|---|
| `<name> - Player.png` | Floor, walls, feature glyphs, grid, baked light wedges. **No key numbers, no legend, no secret labels** — safe to show players. |
| `<name> - DM.png` | The Player base **plus** a numbered red circle at each key, small feature labels, and a right-hand **legend panel** listing `n → label — note`. Secret/hazard notes live here only. |
| `<name>.dd2vtt` | Universal VTT 0.3: `resolution`, base64 of the **Player** PNG, `line_of_sight` walls, `portals` (doors), `lights`, `environment`. |

## Dependency

Pillow (PIL). **Installed in the devcontainer at container start** by
`scripts/project-setup.sh`, which runs as the last step of `postStartCommand`.

It used to be the `python3-pil` apt package in `.devcontainer/Dockerfile`, but
that file is template-owned and template-sync deleted the line (issue #69).
Installing at start keeps the Dockerfile byte-identical to the template so
devcontainer security fixes keep reaching this repo.

If the map script reports `No module named 'PIL'`, the start-time install
failed — the container-start log says so. Rerun it by hand:

```bash
pip install --break-system-packages --user Pillow
```

## Foundry import

Install the **Universal Battlemap Importer** module in Foundry, then import the
`.dd2vtt`. It creates a scene from the embedded Player image and reconstructs
walls (from `line_of_sight`), doors (`portals`), and light sources (`lights`)
at the correct grid scale (`pixels_per_grid`). The DM PNG is a GM reference
handout, not imported as a play surface.

## Spec format

All coordinates are in **grid units** (pixels = grid × `ppg`).

```json
{
  "name": "The Belfry",
  "grid": {"w": 16, "h": 16},
  "ppg": 72,
  "floor": {"shape": "octagon", "bounds": [2, 2, 14, 14], "chamfer": 3},
  "walls": [ [[6.5,6.5],[9.5,6.5],[9.5,9.5],[6.5,9.5],[6.5,6.5]] ],
  "features": [
    {"type": "bell",     "at": [8, 8],       "size": 3, "label": "GREAT BELL"},
    {"type": "arch",     "at": [8, 2],       "dir": "n"},
    {"type": "trapdoor", "at": [11.5, 11.5], "size": 2},
    {"type": "marker",   "at": [8, 9.3],     "label": "Sela"}
  ],
  "keys": [
    {"n": 1, "at": [8, 8],       "label": "Great Bell", "note": "difficult terrain + partial cover"},
    {"n": 2, "at": [11.5, 11.5], "label": "Trapdoor",   "note": "entry from the clock room below"}
  ],
  "lights": [ {"at": [8, 2.4], "range": 6, "color": "cfe0ff"} ]
}
```

### Top-level keys

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Basename for output files and the legend title. |
| `grid` | yes | `{"w": cols, "h": rows}` in grid squares. |
| `ppg` | no (72) | Pixels per grid square. |
| `floor` | yes | Floor shape — see below. |
| `walls` | no | List of polylines (each a list of `[x,y]` points) drawn as walls and added to `line_of_sight`. |
| `features` | no | Feature glyphs — see below. |
| `keys` | no | DM-map numbered keys + legend entries. |
| `lights` | no | Light sources written to the `.dd2vtt`. |

### `floor.shape`

| Shape | Fields | Notes |
|---|---|---|
| `rect` | `bounds: [x0,y0,x1,y1]` | Rectangular floor. |
| `octagon` | `bounds: [x0,y0,x1,y1]`, `chamfer` | Rectangle with corners cut back `chamfer` units. |
| `polygon` | `points: [[x,y], ...]` | Arbitrary outline. |

Optional `floor.color: [r,g,b]` overrides the default timber tan. The floor
outline is also the primary `line_of_sight` perimeter wall.

### Feature types

Each feature has a `type`, an `at: [x,y]` centre, and optional `size`, `dir`
(`n`/`e`/`s`/`w`), and `label`. `label` is drawn on the **DM map only**.
Glyphs are schematic (this is a "simple battlemap", not fine art).

| `type` | Draws | Uses | LOS / portal |
|---|---|---|---|
| `bell` | Stone platform + shaft-gap ring + bronze bell + hanging rope | `size` | platform → LOS obstacle |
| `arch` | Louvered wall opening + baked moonlight wedge pointing inward | `dir` | — |
| `door` | Wooden door leaf across a wall | `dir` | → `.dd2vtt` **portal** |
| `trapdoor` | Ladder hatch | `size` | — |
| `stairs` | Stepped block | `size`, `dir` | — |
| `pillar` | Stone column | `size` | small LOS obstacle |
| `water` | Translucent pool | `size` | — |
| `rubble` | Scattered debris | `size` | — |
| `marker` | Subtle disc (e.g. a ghost's spot); `label` shown on DM only | `size` | — |
| *anything else* | Labelled fallback disc (never crashes) | `size` | — |

### `keys`

`{"n": <int>, "at": [x,y], "label": "...", "note": "..."}` — draws a numbered
circle at `at` on the DM map and a matching legend row `n → label — note`.
Notes are the place for secrets/hazards; they never appear on the Player map.

### `lights`

`{"at": [x,y], "range": <grid>, "color": "rrggbb", "intensity": 0.5, "shadows": true}`
— written into the `.dd2vtt` `lights` array. `color` may be `rrggbb` or
`rrggbbaa` (6-digit is padded with `ff`). `intensity` and `shadows` are
optional. Arch features additionally bake a static moonlight wedge into the PNG
itself.

## Example

`examples/belfry.json` reproduces the original belfry (octagon bell tower with
four louvered arches, a central great bell, an SE trapdoor, and a ghost
marker). Build it with:

```bash
python3 scripts/maps/render_map.py scripts/maps/examples/belfry.json /tmp/out
```
