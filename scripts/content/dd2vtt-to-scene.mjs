#!/usr/bin/env node
/**
 * Convert a Universal VTT (.dd2vtt, format 0.3 — as emitted by
 * scripts/maps/render_map.py) into a FoundryVTT v13 Scene document, ready to
 * drop into content/src-<slug>/scenes/ and compile with build.mjs.
 *
 * v1 converts geometry only — walls (line_of_sight), doors (portals), and
 * lights — the tedious parts. It is a BASE scene to refine by hand in the VTT;
 * hand-refinements do not round-trip back here. The compendium ships NO image:
 * --background must point at the Player PNG already under the Foundry data dir
 * (the vault mount), Data-relative.
 *
 * Usage:
 *   node scripts/content/dd2vtt-to-scene.mjs <file.dd2vtt> --background <src> \
 *     [--out <path>] [--name "<Scene>"] [--grid-distance 5] [--global-light]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PPG = 72;
const DEFAULT_GRID_DISTANCE = 5;
const NORMAL = 20; // CONST.WALL_SENSE_TYPES.NORMAL — Foundry defaults this anyway.

// dd2vtt colors are `rrggbb` or `rrggbbaa` (optionally #-prefixed). Foundry
// wants a `#rrggbb` string; alpha is carried separately (from intensity).
export function hexColor(raw, fallback = '#ffffff') {
  if (typeof raw !== 'string') return fallback;
  const h = raw.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6,8}$/.test(h)) return fallback;
  return `#${h.slice(0, 6).toLowerCase()}`;
}

function ptsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

// Each line_of_sight polyline -> one wall segment per adjacent point pair.
// Coordinates are grid units; Foundry walls are pixels, so scale by ppg.
// Zero-length segments (coincident points) are dropped.
export function wallsFromLOS(los, ppg) {
  const walls = [];
  for (const line of los ?? []) {
    if (!Array.isArray(line)) continue;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (!a || !b || ptsEqual(a, b)) continue;
      walls.push({ c: [a.x * ppg, a.y * ppg, b.x * ppg, b.y * ppg] });
    }
  }
  return walls;
}

// Each portal (door) -> one wall segment flagged as a closed door.
export function doorsFromPortals(portals, ppg) {
  const doors = [];
  for (const p of portals ?? []) {
    const b = p?.bounds;
    if (!Array.isArray(b) || b.length < 2) continue;
    const [a, c] = b;
    if (!a || !c || ptsEqual(a, c)) continue;
    doors.push({ c: [a.x * ppg, a.y * ppg, c.x * ppg, c.y * ppg], door: 1, ds: 0 });
  }
  return doors;
}

// dd2vtt light -> Foundry AmbientLight. `range` is in grid squares; Foundry
// dim/bright radii are in scene distance units (feet), so multiply by distance.
export function lightFromDd2vtt(light, ppg, distance) {
  const pos = light?.position ?? { x: 0, y: 0 };
  const range = Number(light?.range ?? 6);
  const intensity = Number(light?.intensity ?? 0.5);
  const alpha = Math.min(1, Math.max(0, intensity));
  return {
    x: pos.x * ppg,
    y: pos.y * ppg,
    rotation: 0,
    walls: true,
    vision: false,
    config: {
      dim: range * distance,
      bright: (range * distance) / 2,
      color: hexColor(light?.color, '#ffdca8'),
      alpha,
    },
  };
}

export function sceneFromDd2vtt(dd, opts = {}) {
  const {
    name = 'Map',
    background,
    gridDistance = DEFAULT_GRID_DISTANCE,
    globalLight = false,
  } = opts;
  const res = dd.resolution ?? {};
  const ppg = Number(res.pixels_per_grid ?? DEFAULT_PPG);
  const size = res.map_size ?? { x: 0, y: 0 };

  const walls = [
    ...wallsFromLOS(dd.line_of_sight, ppg),
    ...doorsFromPortals(dd.portals, ppg),
  ];
  const lights = (dd.lights ?? []).map(l => lightFromDd2vtt(l, ppg, gridDistance));

  const scene = {
    name,
    width: size.x * ppg,
    height: size.y * ppg,
    // padding 0: dd2vtt/image coords are 0-based, so scene coords must be too.
    // A non-zero padding offsets the background from the scene origin, but our
    // walls/lights are at raw image pixels — any padding would misalign them.
    padding: 0,
    grid: { type: 1, size: ppg, distance: gridDistance, units: 'ft' },
    tokenVision: true,
    // Global light off by default so walls + lights matter; darkness/dynamic
    // lighting is a hand-refine step in the VTT.
    environment: { globalLight: { enabled: globalLight } },
    walls,
    lights,
  };
  if (background) scene.background = { src: background };
  return scene;
}

// Foundry's WALL sense-type default; exported for the tests to reference.
export const WALL_NORMAL = NORMAL;

export function parseArgs(argv) {
  const opts = { gridDistance: DEFAULT_GRID_DISTANCE, globalLight: false };
  let input;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--background': opts.background = argv[++i]; break;
      case '--out': opts.out = argv[++i]; break;
      case '--name': opts.name = argv[++i]; break;
      case '--grid-distance': opts.gridDistance = Number(argv[++i]); break;
      case '--global-light': opts.globalLight = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
        if (input) throw new Error(`Unexpected extra argument: ${arg}`);
        input = arg;
    }
  }
  if (!input) throw new Error('Missing <file.dd2vtt> argument');
  if (!opts.background) {
    throw new Error(
      '--background is required: the Foundry Data-relative path to the Player ' +
      'PNG under the vault mount (e.g. "DnD/<game>/Assets/Maps/<name> - Player.png"). ' +
      'The compendium ships no image.',
    );
  }
  return { input, opts };
}

export async function convertFile(input, opts) {
  const dd = JSON.parse(await readFile(input, 'utf8'));
  const name = opts.name ?? path.basename(input).replace(/\.dd2vtt$/i, '');
  const scene = sceneFromDd2vtt(dd, { ...opts, name });
  const out = opts.out ?? path.join(process.cwd(), `${name}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(scene, null, 2));
  return { out, scene };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { input, opts } = parseArgs(process.argv.slice(2));
    const { out, scene } = await convertFile(input, opts);
    console.log(
      `Wrote ${scene.name}: ${scene.walls.length} walls, ${scene.lights.length} lights -> ${out}`,
    );
    console.log('Next: build + sync the module, then import the scene in Foundry.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
