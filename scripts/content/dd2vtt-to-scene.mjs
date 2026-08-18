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
 *     [--out <path>] [--name "<Scene>"] [--grid-distance 5] [--global-light] \
 *     [--keys <spec.json> --keys-journal <path>]
 *
 * --keys reads the map spec's numbered `keys` — the ones render_map.py draws on
 * the DM PNG — and emits a GM-only "<Scene> — GM Keys" journal (one page per
 * key) plus a scene Note pinned at each key. The GM clicks pin 4 instead of
 * reading the legend off the DM image.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docId } from './build.mjs';

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

// A map spec's `keys` are what render_map.py draws as numbered circles on the DM
// PNG and lists in its legend. The same array becomes a GM-only journal (one
// page per key) plus a scene Note pinned at each key's coordinates, so the GM
// clicks pin 4 instead of cross-referencing the legend by eye.
//
// The journal is addressed by the path build.mjs will stage it under, so the
// ids here match the ones the compiled pack will carry.
export function keysJournal(keys, sceneName, journalRelPath) {
  const pages = keys.map((k, i) => ({
    _id: docId(`${journalRelPath}#pages[${i}]`),
    name: `${k.n}. ${k.label ?? 'Key'}`,
    type: 'text',
    title: { show: true, level: 1 },
    // Keys routinely hold the scene's secrets — GM-only, like the rest of the
    // GM shelf. Foundry hides a Note whose journal the player cannot see.
    ownership: { default: 0 },
    text: { content: `<p>${k.note ?? ''}</p>`, format: 1 },
    sort: (i + 1) * 100,
  }));
  return {
    _id: docId(journalRelPath),
    name: `${sceneName} — GM Keys`,
    ownership: { default: 0 },
    pages,
  };
}

// Foundry v13 removed the automatic migration of the legacy Note#icon string to
// Note#texture.src (deprecated in v10), so a v13+ scene MUST use texture.src or
// the pin renders without its icon. Fields beyond these are deliberately left
// out and defaulted by Foundry rather than guessed at.
const NOTE_ICON = 'icons/svg/book.svg';

export function notesFromKeys(keys, ppg, journalRelPath) {
  return keys.map((k, i) => {
    const [gx, gy] = k.at ?? [0, 0];
    return {
      entryId: docId(journalRelPath),
      pageId: docId(`${journalRelPath}#pages[${i}]`),
      x: gx * ppg,
      y: gy * ppg,
      texture: { src: NOTE_ICON },
      iconSize: 40,
      text: `${k.n}. ${k.label ?? 'Key'}`,
    };
  });
}

export function sceneFromDd2vtt(dd, opts = {}) {
  const {
    name = 'Map',
    background,
    gridDistance = DEFAULT_GRID_DISTANCE,
    globalLight = false,
    noLights = false,
    keys = [],
    journalRelPath,
  } = opts;
  const res = dd.resolution ?? {};
  const ppg = Number(res.pixels_per_grid ?? DEFAULT_PPG);
  const size = res.map_size ?? { x: 0, y: 0 };

  const width = size.x * ppg;
  const height = size.y * ppg;

  // Foundry insets the background by `padding` (rounded up to whole grid
  // squares) from the scene origin and places walls/lights in that PADDED
  // space. Our dd2vtt coords are 0-based image pixels, so shift every placeable
  // by the same offset to land on the background. padding must be a valid
  // non-zero value — Foundry rejects a scene with padding 0 on import.
  const PADDING = 0.25;
  const offsetX = Math.ceil((PADDING * width) / ppg) * ppg;
  const offsetY = Math.ceil((PADDING * height) / ppg) * ppg;
  // Grid-unit coords times ppg accumulate float noise (1267.1999999999998).
  // Sub-pixel precision is meaningless for placeables, and the long digit runs
  // trip secret-scanning heuristics in the committed JSON.
  const px = n => Math.round(n * 100) / 100;
  const shiftWall = w => ({
    ...w,
    c: [px(w.c[0] + offsetX), px(w.c[1] + offsetY), px(w.c[2] + offsetX), px(w.c[3] + offsetY)],
  });
  const shiftLight = l => ({ ...l, x: px(l.x + offsetX), y: px(l.y + offsetY) });
  const shiftNote = n => ({ ...n, x: px(n.x + offsetX), y: px(n.y + offsetY) });

  const walls = [...wallsFromLOS(dd.line_of_sight, ppg), ...doorsFromPortals(dd.portals, ppg)].map(
    shiftWall,
  );
  // render_map bakes light into the Player PNG, so its dynamic lights would
  // double up; --no-lights ships the baked map with no dynamic lights.
  const lights = (
    noLights ? [] : (dd.lights ?? []).map(l => lightFromDd2vtt(l, ppg, gridDistance))
  ).map(shiftLight);

  // Pins only exist when the caller passed a spec's keys AND told us where the
  // companion journal will live — without the path the ids could not resolve.
  const notes =
    keys.length && journalRelPath ? notesFromKeys(keys, ppg, journalRelPath).map(shiftNote) : [];

  const scene = {
    name,
    width,
    height,
    padding: PADDING,
    grid: { type: 1, size: ppg, distance: gridDistance, units: 'ft' },
    tokenVision: true,
    // Global light off by default so walls + lights matter; darkness/dynamic
    // lighting is a hand-refine step in the VTT.
    environment: { globalLight: { enabled: globalLight } },
    walls,
    lights,
    notes,
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
      case '--background':
        opts.background = argv[++i];
        break;
      case '--out':
        opts.out = argv[++i];
        break;
      case '--name':
        opts.name = argv[++i];
        break;
      case '--grid-distance':
        opts.gridDistance = Number(argv[++i]);
        break;
      case '--global-light':
        opts.globalLight = true;
        break;
      case '--no-lights':
        opts.noLights = true;
        break;
      case '--keys':
        opts.keys = argv[++i];
        break;
      case '--keys-journal':
        opts.keysJournal = argv[++i];
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
        if (input) throw new Error(`Unexpected extra argument: ${arg}`);
        input = arg;
    }
  }
  if (!input) throw new Error('Missing <file.dd2vtt> argument');
  if (opts.keys && !opts.keysJournal) {
    throw new Error('--keys requires --keys-journal <path>: the pins reference that journal by id');
  }
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
  const sortKeys = (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;

  const name = opts.name ?? path.basename(input).replace(/\.dd2vtt$/i, '');

  // Pull the numbered keys straight from the map spec — the same array
  // render_map.py drew on the DM PNG, so pins and legend cannot drift.
  let keys = [];
  let journalRelPath;
  if (opts.keys) {
    const spec = JSON.parse(await readFile(opts.keys, 'utf8'));
    keys = Array.isArray(spec.keys) ? spec.keys : [];
    // build.mjs derives ids from "<type>/<file>.json", so address the journal
    // by the path it will be staged under, not by where it sits on disk.
    journalRelPath = `journals/${path.basename(opts.keysJournal)}`;
  }

  const scene = sceneFromDd2vtt(dd, { ...opts, name, keys, journalRelPath });
  const out = opts.out ?? path.join(process.cwd(), `${name}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  // Match pre-commit's pretty-format-json (sorted keys, 2-space indent,
  // trailing newline) so a freshly generated scene commits without the hook
  // rewriting it and failing the first attempt.
  await writeFile(out, `${JSON.stringify(scene, sortKeys, 2)}\n`);

  let journalOut;
  if (keys.length && opts.keysJournal) {
    const journal = keysJournal(keys, name, journalRelPath);
    journalOut = opts.keysJournal;
    await mkdir(path.dirname(journalOut), { recursive: true });
    await writeFile(journalOut, `${JSON.stringify(journal, sortKeys, 2)}\n`);
  }

  return { out, scene, journalOut };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { input, opts } = parseArgs(process.argv.slice(2));
    const { out, scene, journalOut } = await convertFile(input, opts);
    console.log(
      `Wrote ${scene.name}: ${scene.walls.length} walls, ${scene.lights.length} lights, ` +
        `${scene.notes.length} pins -> ${out}`,
    );
    if (journalOut)
      console.log(`Wrote GM keys journal (${scene.notes.length} pages) -> ${journalOut}`);
    console.log('Next: build + sync the module, then import the scene in Foundry.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
