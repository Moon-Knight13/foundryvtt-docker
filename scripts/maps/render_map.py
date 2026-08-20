#!/usr/bin/env python3
"""render_map.py — spec-driven battlemap generator.

Emit TWO variants from one JSON layout spec plus a Foundry Universal VTT file:

  <name> - Player.webp  clean map (floor, walls, feature glyphs, grid, baked light)
  <name> - DM.webp      player base + numbered keys, feature labels, legend panel
  <name>.dd2vtt         Universal VTT 0.3 (walls, portals, lights, base64 Player PNG)

Images are LOSSLESS WebP, which on these flat-colour schematics runs 60-70%
smaller than PNG with no artifacts (measured: Player -63%, DM -71%). Pass --png
for a consumer that cannot read WebP. The .dd2vtt always embeds a PNG whatever
the output format — that is fixed by the Universal VTT spec.

Usage:
    python3 scripts/maps/render_map.py <spec.json> <outdir> [--png]

Dependency: Pillow  ->  pip install --break-system-packages --user Pillow

The spec schema and feature glyphs are documented in scripts/maps/README.md.
All coordinates in a spec are in GRID units; pixels = grid * ppg.
"""
from __future__ import annotations

import base64
import json
import math
import os
import sys
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------- #
# Palette (schematic top-down battlemap)
# --------------------------------------------------------------------------- #
VOID        = (13, 13, 16, 255)      # background / dark
FLOOR_TAN   = (214, 196, 138, 255)   # default timber floor
PLANK       = (150, 132, 86, 70)
GRID_LINE   = (60, 50, 30, 60)
WALL        = (58, 55, 48, 255)
STONE       = (96, 92, 86, 255)
STONE_EDGE  = (60, 57, 52, 255)
DARK_GAP    = (20, 18, 22, 255)
BRONZE      = (150, 110, 52, 255)
BRONZE_EDGE = (90, 64, 28, 255)
ROPE        = (70, 52, 30, 255)
WOOD_DARK   = (46, 34, 24, 255)
WOOD_EDGE   = (24, 18, 12, 255)
WOOD_RUNG   = (96, 72, 48, 255)
LOUVER_BG   = (38, 40, 52, 255)
LOUVER_SLAT = (120, 128, 150, 200)
MOONLIGHT   = (225, 230, 255, 34)
WATER       = (54, 96, 138, 150)
WATER_EDGE  = (70, 120, 170, 180)
RUBBLE      = (120, 110, 92, 220)
PIT_DARK    = (22, 20, 24, 255)
PIT_EDGE    = (58, 52, 48, 255)
PILLAR      = (110, 106, 100, 255)
PILLAR_EDGE = (70, 67, 62, 255)
DOOR_WOOD   = (104, 74, 44, 255)
DOOR_EDGE   = (60, 42, 24, 255)
LABEL_INK   = (70, 60, 44, 220)

# DM overlay / legend colours
KEY_FILL    = (150, 30, 30, 255)
KEY_EDGE    = (250, 240, 230, 255)
KEY_TEXT    = (255, 245, 235, 255)
PANEL_BG    = (24, 22, 26, 255)
PANEL_LINE  = (70, 66, 74, 255)
PANEL_TITLE = (235, 225, 210, 255)
PANEL_LABEL = (230, 220, 205, 255)
PANEL_NOTE  = (170, 162, 150, 255)


# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #
_FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def _font(name: str, size: int):
    try:
        return ImageFont.truetype(os.path.join(_FONT_DIR, name), size)
    except Exception:
        return ImageFont.load_default()


def serif(size):      return _font("DejaVuSerif.ttf", size)
def serif_bold(size): return _font("DejaVuSerif-Bold.ttf", size)
def sans(size):       return _font("DejaVuSans.ttf", size)
def sans_bold(size):  return _font("DejaVuSans-Bold.ttf", size)


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
class Canvas:
    """Wraps a grid-addressed RGBA image so features draw in grid units."""

    def __init__(self, gw: int, gh: int, ppg: int):
        self.gw, self.gh, self.ppg = gw, gh, ppg
        self.size = (gw * ppg, gh * ppg)
        self.img = Image.new("RGBA", self.size, VOID)
        self.d = ImageDraw.Draw(self.img, "RGBA")

    def g(self, v: float) -> int:
        return int(round(v * self.ppg))

    def gp(self, pt) -> tuple:
        return (self.g(pt[0]), self.g(pt[1]))

    def refresh(self):
        """Re-bind the draw context after an alpha_composite swap."""
        self.d = ImageDraw.Draw(self.img, "RGBA")

    def overlay(self):
        return Image.new("RGBA", self.size, (0, 0, 0, 0))

    def composite(self, ov):
        self.img = Image.alpha_composite(self.img, ov)
        self.refresh()


def floor_polygon(floor: dict):
    """Return floor outline as a list of (x, y) grid points (open ring)."""
    shape = floor.get("shape", "rect")
    if shape == "rect":
        x0, y0, x1, y1 = floor["bounds"]
        return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if shape == "octagon":
        x0, y0, x1, y1 = floor["bounds"]
        c = floor.get("chamfer", 2)
        return [
            (x0 + c, y0), (x1 - c, y0),
            (x1, y0 + c), (x1, y1 - c),
            (x1 - c, y1), (x0 + c, y1),
            (x0, y1 - c), (x0, y0 + c),
        ]
    if shape == "polygon":
        return [tuple(p) for p in floor["points"]]
    raise ValueError(f"unknown floor.shape: {shape!r}")


DIR_INWARD = {"n": (0, 1), "s": (0, -1), "e": (-1, 0), "w": (1, 0)}


# --------------------------------------------------------------------------- #
# Base map (shared by Player + DM)
# --------------------------------------------------------------------------- #
def draw_floor(cv: Canvas, floor: dict, poly):
    color = tuple(floor.get("color", FLOOR_TAN[:3])) + (255,)
    cv.d.polygon([cv.gp(p) for p in poly], fill=color)
    # plank lines across the floor bounding box (timber grain)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    for gy in range(int(math.ceil(y0)), int(math.floor(y1)) + 1):
        cv.d.line([(cv.g(x0), cv.g(gy)), (cv.g(x1), cv.g(gy))], fill=PLANK, width=2)


def draw_grid(cv: Canvas):
    ov = cv.overlay()
    gd = ImageDraw.Draw(ov)
    for i in range(cv.gw + 1):
        gd.line([(cv.g(i), 0), (cv.g(i), cv.size[1])], fill=GRID_LINE, width=1)
    for j in range(cv.gh + 1):
        gd.line([(0, cv.g(j)), (cv.size[0], cv.g(j))], fill=GRID_LINE, width=1)
    cv.composite(ov)


def draw_walls(cv: Canvas, poly, walls):
    px = [cv.gp(p) for p in poly]
    cv.d.line(px + [px[0]], fill=WALL, width=14, joint="curve")
    for w in walls:
        pts = [cv.gp(p) for p in w]
        cv.d.line(pts, fill=WALL, width=12, joint="curve")


def bake_wedge(cv: Canvas, at, dxdy):
    cx, cy = at
    dx, dy = dxdy
    L = 6.5 * cv.ppg
    sp = 2.2 * cv.ppg
    p0 = (cv.g(cx), cv.g(cy))
    p1 = (cv.g(cx) + int(dx * L - dy * sp), cv.g(cy) + int(dy * L - dx * sp))
    p2 = (cv.g(cx) + int(dx * L + dy * sp), cv.g(cy) + int(dy * L + dx * sp))
    ov = cv.overlay()
    ImageDraw.Draw(ov).polygon([p0, p1, p2], fill=MOONLIGHT)
    cv.composite(ov)


# --------------------------------------------------------------------------- #
# Feature glyphs.  Each returns an optional LOS obstacle (list of grid points).
# --------------------------------------------------------------------------- #
def feat_bell(cv: Canvas, f):
    x, y = f["at"]
    s = f.get("size", 3)
    half = s / 2.0
    gap = half + 1.0
    # shaft-gap ring (dark) around the platform
    cv.d.rectangle([cv.g(x - gap), cv.g(y - gap), cv.g(x + gap), cv.g(y + gap)], fill=DARK_GAP)
    # stone platform
    cv.d.rectangle([cv.g(x - half), cv.g(y - half), cv.g(x + half), cv.g(y + half)],
                   fill=STONE, outline=STONE_EDGE, width=5)
    # the great bell
    r = half - 0.5
    cv.d.ellipse([cv.g(x - r) + 6, cv.g(y - r) + 6, cv.g(x + r) - 6, cv.g(y + r) - 6],
                 fill=BRONZE, outline=BRONZE_EDGE, width=6)
    cv.d.ellipse([cv.g(x - 0.3), cv.g(y - 0.3), cv.g(x + 0.3), cv.g(y + 0.3)], fill=BRONZE_EDGE)
    # rope hanging down
    cv.d.line([(cv.g(x), cv.g(y)), (cv.g(x), cv.g(y + s + 0.2))], fill=ROPE, width=5)
    return [(x - half, y - half), (x + half, y - half),
            (x + half, y + half), (x - half, y + half), (x - half, y - half)]


def feat_arch(cv: Canvas, f):
    x, y = f["at"]
    d = f.get("dir", "n")
    horiz = d in ("n", "s")
    w = 1.1 * cv.ppg
    if horiz:
        box = [cv.g(x) - int(w), cv.g(y) - 14, cv.g(x) + int(w), cv.g(y) + 14]
    else:
        box = [cv.g(x) - 14, cv.g(y) - int(w), cv.g(x) + 14, cv.g(y) + int(w)]
    cv.d.rectangle(box, fill=LOUVER_BG)
    for k in range(-1, 2):
        if horiz:
            cv.d.line([(cv.g(x) + k * 22, box[1]), (cv.g(x) + k * 22, box[3])], fill=LOUVER_SLAT, width=3)
        else:
            cv.d.line([(box[0], cv.g(y) + k * 22), (box[2], cv.g(y) + k * 22)], fill=LOUVER_SLAT, width=3)
    return None


def feat_door(cv: Canvas, f):
    x, y = f["at"]
    d = f.get("dir", "n")
    horiz = d in ("n", "s")
    lw = 0.9 * cv.ppg
    if horiz:
        box = [cv.g(x) - int(lw), cv.g(y) - 12, cv.g(x) + int(lw), cv.g(y) + 12]
    else:
        box = [cv.g(x) - 12, cv.g(y) - int(lw), cv.g(x) + 12, cv.g(y) + int(lw)]
    cv.d.rectangle(box, fill=DOOR_WOOD, outline=DOOR_EDGE, width=3)
    return None  # doors become portals, not LOS walls


def feat_trapdoor(cv: Canvas, f):
    x, y = f["at"]
    s = f.get("size", 2) * 0.9
    h = s / 2.0
    cv.d.rectangle([cv.g(x - h), cv.g(y - h), cv.g(x + h), cv.g(y + h)],
                   fill=WOOD_DARK, outline=WOOD_EDGE, width=5)
    step = s / 4.0
    for k in range(1, 4):
        yy = cv.g(y - h + k * step)
        cv.d.line([(cv.g(x - h), yy), (cv.g(x + h), yy)], fill=WOOD_RUNG, width=3)
    return None


def feat_stairs(cv: Canvas, f):
    x, y = f["at"]
    s = f.get("size", 2)
    d = f.get("dir", "n")
    h = s / 2.0
    cv.d.rectangle([cv.g(x - h), cv.g(y - h), cv.g(x + h), cv.g(y + h)],
                   fill=STONE, outline=STONE_EDGE, width=3)
    n = max(3, int(s * 2))
    for k in range(1, n):
        t = k / n
        if d in ("n", "s"):
            yy = cv.g(y - h + t * s)
            cv.d.line([(cv.g(x - h), yy), (cv.g(x + h), yy)], fill=STONE_EDGE, width=3)
        else:
            xx = cv.g(x - h + t * s)
            cv.d.line([(xx, cv.g(y - h)), (xx, cv.g(y + h))], fill=STONE_EDGE, width=3)
    return None


def feat_pillar(cv: Canvas, f):
    x, y = f["at"]
    r = f.get("size", 1) / 2.0
    cv.d.ellipse([cv.g(x - r), cv.g(y - r), cv.g(x + r), cv.g(y + r)],
                 fill=PILLAR, outline=PILLAR_EDGE, width=4)
    # small square LOS obstacle
    hs = r * 0.7
    return [(x - hs, y - hs), (x + hs, y - hs), (x + hs, y + hs), (x - hs, y + hs), (x - hs, y - hs)]


def feat_water(cv: Canvas, f):
    x, y = f["at"]
    s = f.get("size", 2)
    h = s / 2.0
    ov = cv.overlay()
    od = ImageDraw.Draw(ov)
    od.ellipse([cv.g(x - h), cv.g(y - h * 0.85), cv.g(x + h), cv.g(y + h * 0.85)],
               fill=WATER, outline=WATER_EDGE, width=3)
    cv.composite(ov)
    return None


def feat_pit(cv: Canvas, f):
    """A ragged chasm — an ellipse with a jittered edge, black to the bottom.

    Sized by `w`/`h` in grid units so it can span a corridor wall-to-wall
    (`size` sets both if given). Returns no LOS: you can see across a hole.
    """
    x, y = f["at"]
    s = f.get("size", 3)
    w = float(f.get("w", s))
    h = float(f.get("h", s))
    import random
    rnd = random.Random(int((x * 733 + y * 311) * 1000))
    steps = 48
    ring = []
    for i in range(steps):
        t = i / steps * math.tau
        j = 1.0 + rnd.uniform(-0.08, 0.08)
        ring.append((x + math.cos(t) * (w / 2.0) * j,
                     y + math.sin(t) * (h / 2.0) * j))
    cv.d.polygon([cv.gp(pt) for pt in ring], fill=PIT_DARK, outline=PIT_EDGE, width=4)
    # Depth cue: a second, blacker ring inset toward the centre.
    inner = [(x + (px - x) * 0.7, y + (py - y) * 0.7) for px, py in ring]
    cv.d.polygon([cv.gp(pt) for pt in inner], fill=VOID)
    return None


def feat_rubble(cv: Canvas, f):
    x, y = f["at"]
    s = f.get("size", 1.5)
    h = s / 2.0
    import random
    rnd = random.Random(int((x * 131 + y * 977) * 1000))
    for _ in range(int(14 * s)):
        rx = x + rnd.uniform(-h, h)
        ry = y + rnd.uniform(-h, h)
        rr = rnd.uniform(0.06, 0.16)
        cv.d.ellipse([cv.g(rx - rr), cv.g(ry - rr), cv.g(rx + rr), cv.g(ry + rr)], fill=RUBBLE)
    return None


def feat_marker(cv: Canvas, f):
    x, y = f["at"]
    r = f.get("size", 0.4)
    ov = cv.overlay()
    ImageDraw.Draw(ov).ellipse([cv.g(x - r), cv.g(y - r), cv.g(x + r), cv.g(y + r)],
                               fill=(180, 205, 225, 90))
    cv.composite(ov)
    return None


def feat_unknown(cv: Canvas, f):
    """Fallback: a labelled disc so an unrecognised type never crashes."""
    x, y = f["at"]
    r = f.get("size", 0.5) / 1.0
    cv.d.ellipse([cv.g(x - r), cv.g(y - r), cv.g(x + r), cv.g(y + r)],
                 fill=(120, 100, 130, 200), outline=(60, 50, 70, 255), width=3)
    return None


FEATURES = {
    "bell": feat_bell,
    "arch": feat_arch,
    "door": feat_door,
    "trapdoor": feat_trapdoor,
    "stairs": feat_stairs,
    "pillar": feat_pillar,
    "water": feat_water,
    "pit": feat_pit,
    "rubble": feat_rubble,
    "marker": feat_marker,
}


# --------------------------------------------------------------------------- #
# Build the shared base map
# --------------------------------------------------------------------------- #
def build_base(spec: dict):
    grid = spec["grid"]
    ppg = spec.get("ppg", 72)
    cv = Canvas(grid["w"], grid["h"], ppg)

    poly = floor_polygon(spec["floor"])
    draw_floor(cv, spec["floor"], poly)
    draw_grid(cv)

    # baked moonlight wedges from arch features
    for f in spec.get("features", []):
        if f.get("type") == "arch":
            bake_wedge(cv, f["at"], DIR_INWARD.get(f.get("dir", "n"), (0, 1)))

    draw_walls(cv, poly, spec.get("walls", []))

    # feature glyphs (drawn after walls so arches/doors punch through)
    los_extra = []
    for f in spec.get("features", []):
        fn = FEATURES.get(f.get("type"), feat_unknown)
        obstacle = fn(cv, f)
        if obstacle:
            los_extra.append(obstacle)

    return cv, poly, los_extra, ppg


# --------------------------------------------------------------------------- #
# DM overlay + legend panel
# --------------------------------------------------------------------------- #
def _wrap(draw, text, font, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_dm(base_img: Image.Image, spec: dict, ppg: int) -> Image.Image:
    map_w, map_h = base_img.size
    keys = spec.get("keys", [])

    panel_w = 360 if keys else 0
    dm = Image.new("RGBA", (map_w + panel_w, map_h), PANEL_BG)
    dm.paste(base_img, (0, 0))
    d = ImageDraw.Draw(dm, "RGBA")

    def g(v):
        return int(round(v * ppg))

    # small feature labels (DM only)
    lab_font = serif(max(14, ppg // 4))
    for f in spec.get("features", []):
        lbl = f.get("label")
        if lbl:
            x, y = f["at"]
            d.text((g(x), g(y) - int(0.55 * ppg)), lbl, fill=LABEL_INK, font=lab_font, anchor="mm")

    # numbered key circles
    r = max(11, ppg // 5)
    num_font = sans_bold(max(13, ppg // 5))
    for k in keys:
        x, y = k["at"]
        cx, cy = g(x), g(y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=KEY_FILL, outline=KEY_EDGE, width=3)
        d.text((cx, cy), str(k["n"]), fill=KEY_TEXT, font=num_font, anchor="mm")

    # legend panel
    if keys:
        px = map_w + 24
        d.line([(map_w, 0), (map_w, map_h)], fill=PANEL_LINE, width=2)
        title_font = serif_bold(26)
        d.text((px, 24), (spec.get("name", "Map") + " — KEY"), fill=PANEL_TITLE, font=title_font)
        y = 78
        label_font = sans_bold(18)
        note_font = sans(15)
        max_w = panel_w - 48
        for k in keys:
            # numbered chip
            cr = 13
            d.ellipse([px, y, px + 2 * cr, y + 2 * cr], fill=KEY_FILL, outline=KEY_EDGE, width=2)
            d.text((px + cr, y + cr), str(k["n"]), fill=KEY_TEXT, font=sans_bold(15), anchor="mm")
            # The label wraps too. It used to be drawn as a single unwrapped
            # run, so any label longer than the panel was silently sliced off
            # at the image edge — the legend read "Otty's crime scene — the bloo".
            label_lines = _wrap(d, k.get("label", ""), label_font, max_w - (2 * cr + 12))
            d.text((px + 2 * cr + 12, y + 1), label_lines[0] if label_lines else "",
                   fill=PANEL_LABEL, font=label_font)
            y += 2 * cr + 6
            for extra in label_lines[1:]:
                d.text((px + 2 * cr + 12, y), extra, fill=PANEL_LABEL, font=label_font)
                y += 22
            note = k.get("note", "")
            if note:
                for ln in _wrap(d, note, note_font, max_w):
                    d.text((px + 4, y), ln, fill=PANEL_NOTE, font=note_font)
                    y += 20
            y += 14
    return dm


# --------------------------------------------------------------------------- #
# .dd2vtt (Universal VTT 0.3)
# --------------------------------------------------------------------------- #
def _pts(seq):
    return [{"x": float(x), "y": float(y)} for x, y in seq]


def _hex_rgba(color: str) -> str:
    c = color.lstrip("#")
    if len(c) == 6:
        c += "ff"
    return c


def build_dd2vtt(spec: dict, poly, los_extra, player_img: "Image.Image") -> dict:
    grid = spec["grid"]
    ppg = spec.get("ppg", 72)
    # The Universal VTT format carries a base64 PNG. That is fixed by the format
    # and independent of what we write to disk, so encode from the image in
    # memory rather than re-reading the output file — otherwise emitting WebP
    # would silently put WebP bytes in a field consumers parse as PNG.
    buf = BytesIO()
    player_img.convert("RGB").save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    los = [_pts(poly + [poly[0]])]
    for w in spec.get("walls", []):
        los.append(_pts(w))
    for ob in los_extra:
        los.append(_pts(ob))

    portals = []
    for f in spec.get("features", []):
        if f.get("type") == "door":
            x, y = f["at"]
            horiz = f.get("dir", "n") in ("n", "s")
            if horiz:
                bounds = [(x - 0.9, y), (x + 0.9, y)]
            else:
                bounds = [(x, y - 0.9), (x, y + 0.9)]
            portals.append({
                "position": {"x": float(x), "y": float(y)},
                "bounds": _pts(bounds),
                "rotation": 0.0,
                "closed": True,
                "freestanding": False,
            })

    lights = []
    for L in spec.get("lights", []):
        x, y = L["at"]
        lights.append({
            "position": {"x": float(x), "y": float(y)},
            "range": float(L.get("range", 6)),
            "intensity": float(L.get("intensity", 0.5)),
            "color": _hex_rgba(L.get("color", "ffdca8")),
            "shadows": bool(L.get("shadows", True)),
        })

    return {
        "format": 0.3,
        "resolution": {
            "map_origin": {"x": 0, "y": 0},
            "map_size": {"x": grid["w"], "y": grid["h"]},
            "pixels_per_grid": ppg,
        },
        "line_of_sight": los,
        "objects_line_of_sight": [],
        "portals": portals,
        "lights": lights,
        "environment": {"baked_lighting": False, "ambient_light": "1a1a20ff"},
        "image": b64,
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    unknown = flags - {"--png"}
    if unknown:
        print(f"unknown argument: {sorted(unknown)[0]}", file=sys.stderr)
        return 2
    if len(args) != 2:
        print("usage: render_map.py <spec.json> <outdir> [--png]", file=sys.stderr)
        return 2
    spec_path, outdir = args
    with open(spec_path) as fh:
        spec = json.load(fh)

    os.makedirs(outdir, exist_ok=True)
    name = spec.get("name", "Map")

    # LOSSLESS WebP by default. Measured on Bandit Hideout: Player 31,683 ->
    # 11,690 bytes (-63%), DM 128,075 -> 36,812 (-71%). Lossy WebP is the wrong
    # tool here and was measurably worse — at quality 90 the Player map grew to
    # 40,330 bytes (+27% over PNG), because these maps are flat colour with thin
    # walls and text labels, which is both what PNG compresses best and what
    # lossy codecs smear. Every byte crosses the GM's upload link to each
    # player. --png restores the old output for a consumer that cannot read WebP.
    webp = "--png" not in flags
    fmt, ext = ("WEBP", "webp") if webp else ("PNG", "png")
    save_opts = {"lossless": True, "method": 6} if webp else {}

    cv, poly, los_extra, ppg = build_base(spec)
    player = cv.img

    player_path = os.path.join(outdir, f"{name} - Player.{ext}")
    player.convert("RGB").save(player_path, fmt, **save_opts)

    dm_img = render_dm(player, spec, ppg)
    dm_path = os.path.join(outdir, f"{name} - DM.{ext}")
    dm_img.convert("RGB").save(dm_path, fmt, **save_opts)

    dd = build_dd2vtt(spec, poly, los_extra, player)
    dd_path = os.path.join(outdir, f"{name}.dd2vtt")
    with open(dd_path, "w") as fh:
        json.dump(dd, fh)

    print(f"Player: {player_path}  {player.size[0]}x{player.size[1]}")
    print(f"DM:     {dm_path}  {dm_img.size[0]}x{dm_img.size[1]}")
    print(f"dd2vtt: {dd_path}  walls={len(dd['line_of_sight'])} "
          f"portals={len(dd['portals'])} lights={len(dd['lights'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
