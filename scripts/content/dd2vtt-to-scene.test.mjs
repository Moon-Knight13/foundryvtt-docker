import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hexColor, wallsFromLOS, doorsFromPortals, lightFromDd2vtt, sceneFromDd2vtt,
  parseArgs, convertFile,
} from './dd2vtt-to-scene.mjs';

// A tiny synthetic dd2vtt: 2x2 grid at 100 px/square, one wall, one door, one light.
const DD = {
  format: 0.3,
  resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 2, y: 2 }, pixels_per_grid: 100 },
  line_of_sight: [[{ x: 0, y: 0 }, { x: 2, y: 0 }]],
  portals: [{ position: { x: 1, y: 0 }, bounds: [{ x: 1, y: 0 }, { x: 1, y: 1 }], closed: true }],
  lights: [{ position: { x: 1, y: 1 }, range: 3, intensity: 0.5, color: 'ffdca8ff' }],
  environment: { ambient_light: '1a1a20ff' },
};

test('hexColor normalizes rrggbb(aa) to #rrggbb, falls back on junk', () => {
  assert.equal(hexColor('ffdca8ff'), '#ffdca8');
  assert.equal(hexColor('#AABBCC'), '#aabbcc');
  assert.equal(hexColor('abc'), '#ffffff');       // wrong length -> fallback
  assert.equal(hexColor(undefined), '#ffffff');
});

test('wallsFromLOS scales grid units by ppg and drops zero-length segments', () => {
  assert.deepEqual(wallsFromLOS(DD.line_of_sight, 100), [{ c: [0, 0, 200, 0] }]);
  assert.deepEqual(wallsFromLOS([[{ x: 1, y: 1 }, { x: 1, y: 1 }]], 100), []);
  // A 3-point polyline yields 2 segments.
  const tri = wallsFromLOS([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]], 100);
  assert.equal(tri.length, 2);
});

test('doorsFromPortals emits a closed door wall', () => {
  assert.deepEqual(doorsFromPortals(DD.portals, 100), [
    { c: [100, 0, 100, 100], door: 1, ds: 0 },
  ]);
  assert.deepEqual(doorsFromPortals([], 100), []);
});

test('lightFromDd2vtt scales position and converts range squares to feet', () => {
  const l = lightFromDd2vtt(DD.lights[0], 100, 5);
  assert.equal(l.x, 100);
  assert.equal(l.y, 100);
  assert.equal(l.config.dim, 15);        // range 3 * distance 5
  assert.equal(l.config.bright, 7.5);    // half of dim
  assert.equal(l.config.color, '#ffdca8');
  assert.equal(l.config.alpha, 0.5);
  assert.equal(l.walls, true);
});

test('sceneFromDd2vtt builds a Foundry scene with pixel dims + combined walls', () => {
  const s = sceneFromDd2vtt(DD, { name: 'Test Map', background: 'DnD/x/Assets/Maps/m.png', gridDistance: 5 });
  assert.equal(s.name, 'Test Map');
  assert.equal(s.width, 200);            // 2 * 100
  assert.equal(s.height, 200);
  assert.equal(s.grid.size, 100);
  assert.equal(s.grid.distance, 5);
  assert.equal(s.grid.type, 1);
  assert.equal(s.walls.length, 2);       // 1 LOS wall + 1 door
  assert.ok(s.walls.some(w => w.door === 1));
  assert.equal(s.lights.length, 1);
  assert.equal(s.background.src, 'DnD/x/Assets/Maps/m.png');
  assert.equal(s.tokenVision, true);
  assert.equal(s.environment.globalLight.enabled, false);
});

test('--global-light enables global illumination', () => {
  const s = sceneFromDd2vtt(DD, { name: 'M', background: 'a.png', globalLight: true });
  assert.equal(s.environment.globalLight.enabled, true);
});

test('parseArgs requires an input file and --background', () => {
  assert.throws(() => parseArgs(['map.dd2vtt']), /--background is required/);
  assert.throws(() => parseArgs(['--background', 'a.png']), /Missing <file\.dd2vtt>/);
  assert.throws(() => parseArgs(['map.dd2vtt', '--nope']), /Unknown argument/);
  const { input, opts } = parseArgs(['map.dd2vtt', '--background', 'a.png', '--grid-distance', '10']);
  assert.equal(input, 'map.dd2vtt');
  assert.equal(opts.gridDistance, 10);
});

test('convertFile writes a scene JSON, name defaults from the dd2vtt filename', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dd2vtt-'));
  const ddPath = path.join(dir, 'The Belfry.dd2vtt');
  await writeFile(ddPath, JSON.stringify(DD));
  const out = path.join(dir, 'scene.json');
  const { scene } = await convertFile(ddPath, { background: 'DnD/x/m.png', out, gridDistance: 5 });
  assert.equal(scene.name, 'The Belfry');
  const written = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(written.width, 200);
  assert.equal(written.walls.length, 2);
});
