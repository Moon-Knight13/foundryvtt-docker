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
| --- | --- |
| `<name> - Player.webp` | Floor, walls, feature glyphs, grid, baked light wedges. **No key numbers, no legend, no secret labels** — safe to show players. |
| `<name> - DM.webp` | The Player base **plus** a numbered red circle at each key, small feature labels, and a right-hand **legend panel** listing `n → label — note`. Secret/hazard notes live here only. |
| `<name>.dd2vtt` | Universal VTT 0.3: `resolution`, base64 of the **Player** map as PNG (fixed by the format, whatever the image files use), `line_of_sight` walls, `portals` (doors), `lights`, `environment`. |

Via `map-to-scene.sh` you also get a compendium **Scene** (walls, lights, doors)
and a GM-only **`<Scene> — GM Keys`** journal with a map pin per numbered key —
see [`keys`](#keys).

## Dependency

Pillow (PIL). **Installed in the devcontainer at container start** by
`scripts/project-setup.sh`, which runs as the last step of `postStartCommand`.

It used to be the `python3-pil` apt package in `.devcontainer/Dockerfile`;
the install moved to container start while the repo still tracked the
upstream template (issue #69) and stays there because it works without an
image rebuild.

If the map script reports `No module named 'PIL'`, the start-time install
failed — the container-start log says so. Rerun it by hand:

```bash
pip install --break-system-packages --user Pillow
```

## Foundry import

Install the **Universal Battlemap Importer** module in Foundry, then import the
`.dd2vtt`. It creates a scene from the embedded Player image and reconstructs
walls (from `line_of_sight`), doors (`portals`), and light sources (`lights`)
at the correct grid scale (`pixels_per_grid`). The DM image is a GM reference
handout, not imported as a play surface.

### Or ship it in the compendium

Convert the `.dd2vtt` into a Foundry Scene document so the map packages and
imports with the rest of the module — same walls/lights/doors, but git-durable
and no manual importer step:

```bash
node scripts/content/dd2vtt-to-scene.mjs "<outdir>/<name>.dd2vtt" \
  --background "DnD/<game>/Assets/Maps/<name> - Player.webp" \
  --out content/src-<slug>/scenes/<name>.json
# or render + convert in one go:
scripts/maps/map-to-scene.sh <spec>.json <slug> --outdir <dir> --background <src>
```

The compendium ships no image, so the Player image must already live under the
Foundry data dir (the vault mount). See `docs/CONTENT_AUTHORING.md` →
"Scenes as code".

### Image format

Output is **lossless WebP**. On these flat-colour schematics that is 60-70%
smaller than PNG with no artifacts — measured on Bandit Hideout, the Player map
went 31,683 -> 11,690 bytes and the DM map 128,075 -> 36,812.

Lossy WebP is the wrong tool here and was measurably worse: at quality 90 the
Player map *grew* to 40,330 bytes, because thin walls, flat fills and text
labels are exactly what PNG compresses well and what lossy codecs smear.

Pass `--png` to either script for a consumer that cannot read WebP. The
`.dd2vtt` always embeds a PNG regardless — that is fixed by the Universal VTT
spec, and the file is byte-identical either way.

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
| --- | --- | --- |
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
| --- | --- | --- |
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
| --- | --- | --- | --- |
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

Keys are also the source of the scene's **GM journal pins**. `map-to-scene.sh`
passes them to `dd2vtt-to-scene.mjs --keys`, which emits a GM-only
`<Scene> — GM Keys` journal (one page per key) beside the scene, plus a Note
pinned at each key's coordinates linking to its page. Pin 4 on the map opens
page 4 in Foundry, with the same numbering as the DM image legend — so the GM
clicks instead of cross-referencing the image. Write a key once; the DM map and
the VTT pin stay in sync because they read the same array.

### `lights`

`{"at": [x,y], "range": <grid>, "color": "rrggbb", "intensity": 0.5,
"shadows": true}` — written into the `.dd2vtt` `lights` array. `color`
may be `rrggbb` or `rrggbbaa` (6-digit is padded with `ff`). `intensity`
and `shadows` are optional. Arch features additionally bake a static
moonlight wedge into the image itself.

## Where specs live

`examples/` holds reference specs for the tool itself. A real game's specs
belong **with that game**, not in this repo — alongside its Obsidian notes, e.g.
`03 Oneshots/<Game>/Foundry/maps/<map>.json`. Point `--scenes-dir` at the game's
`Foundry/src/scenes/` so the generated Scene lands beside the rest of its
sources:

```bash
scripts/maps/map-to-scene.sh "<vault>/<Game>/Foundry/maps/<map>.json" <slug> \
  --outdir "<vault>/<Game>/Assets/Maps" \
  --background "DnD/<Game>/Assets/Maps/<Name> - Player.webp" \
  --scenes-dir "<vault>/<Game>/Foundry/src/scenes"
```

Rendered images and `.dd2vtt` go to the game's `Assets/Maps/` under the vault
mount, where Foundry can serve them.

Two things bite when authoring a spec:

- `size` is a **radius** in grid units, not a diameter. `size: 3` is six squares
  across.
- An unrecognised `type` silently falls back to a labelled disc. Stick to the
  feature table above; use `marker` for anything decorative.

## Example

`examples/belfry.json` reproduces the original belfry (octagon bell tower with
four louvered arches, a central great bell, an SE trapdoor, and a ghost
marker). Build it with:

```bash
python3 scripts/maps/render_map.py scripts/maps/examples/belfry.json /tmp/out
```
