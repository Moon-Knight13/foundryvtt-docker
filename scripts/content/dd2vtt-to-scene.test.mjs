import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hexColor,
  wallsFromLOS,
  doorsFromPortals,
  lightFromDd2vtt,
  sceneFromDd2vtt,
  parseArgs,
  convertFile,
  keysJournal,
  notesFromKeys,
} from './dd2vtt-to-scene.mjs';
import { docId } from './build.mjs';

// A tiny synthetic dd2vtt: 2x2 grid at 100 px/square, one wall, one door, one light.
const DD = {
  format: 0.3,
  resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 2, y: 2 }, pixels_per_grid: 100 },
  line_of_sight: [
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ],
  ],
  portals: [
    {
      position: { x: 1, y: 0 },
      bounds: [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      closed: true,
    },
  ],
  lights: [{ position: { x: 1, y: 1 }, range: 3, intensity: 0.5, color: 'ffdca8ff' }],
  environment: { ambient_light: '1a1a20ff' },
};

test('hexColor normalizes rrggbb(aa) to #rrggbb, falls back on junk', () => {
  assert.equal(hexColor('ffdca8ff'), '#ffdca8');
  assert.equal(hexColor('#AABBCC'), '#aabbcc');
  assert.equal(hexColor('abc'), '#ffffff'); // wrong length -> fallback
  assert.equal(hexColor(undefined), '#ffffff');
});

test('wallsFromLOS scales grid units by ppg and drops zero-length segments', () => {
  assert.deepEqual(wallsFromLOS(DD.line_of_sight, 100), [{ c: [0, 0, 200, 0] }]);
  assert.deepEqual(
    wallsFromLOS(
      [
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
      ],
      100,
    ),
    [],
  );
  // A 3-point polyline yields 2 segments.
  const tri = wallsFromLOS(
    [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    ],
    100,
  );
  assert.equal(tri.length, 2);
});

test('doorsFromPortals emits a closed door wall', () => {
  assert.deepEqual(doorsFromPortals(DD.portals, 100), [{ c: [100, 0, 100, 100], door: 1, ds: 0 }]);
  assert.deepEqual(doorsFromPortals([], 100), []);
});

test('lightFromDd2vtt scales position and converts range squares to feet', () => {
  const l = lightFromDd2vtt(DD.lights[0], 100, 5);
  assert.equal(l.x, 100);
  assert.equal(l.y, 100);
  assert.equal(l.config.dim, 15); // range 3 * distance 5
  assert.equal(l.config.bright, 7.5); // half of dim
  assert.equal(l.config.color, '#ffdca8');
  assert.equal(l.config.alpha, 0.5);
  assert.equal(l.walls, true);
});

test('sceneFromDd2vtt builds a Foundry scene with pixel dims + combined walls', () => {
  const s = sceneFromDd2vtt(DD, {
    name: 'Test Map',
    background: 'DnD/x/Assets/Maps/m.png',
    gridDistance: 5,
  });
  assert.equal(s.name, 'Test Map');
  assert.equal(s.width, 200); // 2 * 100
  assert.equal(s.height, 200);
  assert.equal(s.grid.size, 100);
  assert.equal(s.grid.distance, 5);
  assert.equal(s.grid.type, 1);
  assert.equal(s.walls.length, 2); // 1 LOS wall + 1 door
  assert.ok(s.walls.some(w => w.door === 1));
  assert.equal(s.lights.length, 1);
  assert.equal(s.background.src, 'DnD/x/Assets/Maps/m.png');
  assert.equal(s.tokenVision, true);
  assert.equal(s.padding, 0.25); // valid padding (Foundry rejects 0 on import)
  // Placeables offset by the padding so they land on the padded background:
  // offset = ceil(0.25*200/100)*100 = 100. Raw LOS wall [0,0,200,0] -> +100.
  assert.deepEqual(s.walls[0].c, [100, 100, 300, 100]);
  assert.equal(s.lights[0].x, 200); // raw 100 + offset 100
  assert.equal(s.lights[0].y, 200);
  assert.equal(s.environment.globalLight.enabled, false);
});

test('--global-light enables global illumination', () => {
  const s = sceneFromDd2vtt(DD, { name: 'M', background: 'a.png', globalLight: true });
  assert.equal(s.environment.globalLight.enabled, true);
});

test('--no-lights drops dynamic lights (baked maps)', () => {
  const s = sceneFromDd2vtt(DD, { name: 'M', background: 'a.png', noLights: true });
  assert.equal(s.lights.length, 0);
  assert.equal(s.walls.length, 2); // walls unaffected
});

test('parseArgs requires an input file and --background', () => {
  assert.throws(() => parseArgs(['map.dd2vtt']), /--background is required/);
  assert.throws(() => parseArgs(['--background', 'a.png']), /Missing <file\.dd2vtt>/);
  assert.throws(() => parseArgs(['map.dd2vtt', '--nope']), /Unknown argument/);
  const { input, opts } = parseArgs([
    'map.dd2vtt',
    '--background',
    'a.png',
    '--grid-distance',
    '10',
  ]);
  assert.equal(input, 'map.dd2vtt');
  assert.equal(opts.gridDistance, 10);
});

const KEYS = [
  { n: 1, at: [1, 1], label: 'The rockfall', note: 'SECRET: the boulders are an illusion.' },
  { n: 2, at: [0.5, 1.5], label: 'The hoard', note: '200gp total.' },
];

test('notesFromKeys pins at grid*ppg and links entry + page ids', () => {
  const rel = 'journals/belfry-keys.json';
  const notes = notesFromKeys(KEYS, 100, rel);
  assert.equal(notes.length, 2);
  assert.deepEqual([notes[0].x, notes[0].y], [100, 100]);
  assert.deepEqual([notes[1].x, notes[1].y], [50, 150]);
  // Every pin resolves to the journal entry and to its own page.
  assert.ok(notes.every(n => n.entryId === docId(rel)));
  assert.equal(notes[0].pageId, docId(`${rel}#pages[0]`));
  assert.equal(notes[1].pageId, docId(`${rel}#pages[1]`));
  // Foundry v13 dropped the legacy Note#icon migration — must be texture.src.
  assert.equal(notes[0].texture.src, 'icons/svg/book.svg');
  assert.ok(!('icon' in notes[0]), 'legacy icon field must not be emitted');
  assert.equal(notes[0].text, '1. The rockfall');
});

test('keysJournal is GM-only and its page ids match the pins', () => {
  const rel = 'journals/belfry-keys.json';
  const j = keysJournal(KEYS, 'The Belfry', rel);
  assert.equal(j.name, 'The Belfry — GM Keys');
  assert.equal(j._id, docId(rel));
  assert.equal(j.ownership.default, 0, 'entry must be GM-only — keys hold secrets');
  assert.equal(j.pages.length, 2);
  assert.equal(j.pages[0].name, '1. The rockfall');
  assert.ok(j.pages[0].text.content.includes('illusion'));
  assert.ok(
    j.pages.every(p => p.ownership.default === 0),
    'pages must be GM-only',
  );
  const pins = notesFromKeys(KEYS, 100, rel);
  assert.deepEqual(
    j.pages.map(p => p._id),
    pins.map(p => p.pageId),
  );
});

test('scenes carry no notes unless keys AND a journal path are supplied', () => {
  const bare = sceneFromDd2vtt(DD, { background: 'x.png' });
  assert.deepEqual(bare.notes, []);
  const orphan = sceneFromDd2vtt(DD, { background: 'x.png', keys: KEYS });
  assert.deepEqual(orphan.notes, [], 'keys without a journal path cannot resolve ids');
});

test('parseArgs rejects --keys without --keys-journal', () => {
  assert.throws(
    () => parseArgs(['map.dd2vtt', '--background', 'a.png', '--keys', 'spec.json']),
    /--keys requires --keys-journal/,
  );
});

test('convertFile writes the keys journal and pins the scene from a spec', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dd2vtt-'));
  const ddPath = path.join(dir, 'The Belfry.dd2vtt');
  await writeFile(ddPath, JSON.stringify(DD));
  const specPath = path.join(dir, 'belfry.json');
  await writeFile(specPath, JSON.stringify({ name: 'The Belfry', keys: KEYS }));
  const out = path.join(dir, 'scene.json');
  const keysJournalPath = path.join(dir, 'the-belfry-keys.json');

  const { scene, journalOut } = await convertFile(ddPath, {
    background: 'DnD/x/m.png',
    out,
    gridDistance: 5,
    keys: specPath,
    keysJournal: keysJournalPath,
  });

  assert.equal(scene.notes.length, 2);
  assert.equal(journalOut, keysJournalPath);
  const journal = JSON.parse(await readFile(keysJournalPath, 'utf8'));
  assert.equal(journal.pages.length, 2);
  // The pin's pageId must address the page as build.mjs will stage it, which
  // depends on the journal's FILENAME, not its location on disk.
  const rel = 'journals/the-belfry-keys.json';
  assert.equal(scene.notes[0].entryId, docId(rel));
  assert.deepEqual(
    journal.pages.map(p => p._id),
    scene.notes.map(n => n.pageId),
  );
  // Pins shift with the padding offset exactly like walls and lights do.
  assert.ok(scene.notes.every(n => n.x >= 0 && n.y >= 0));
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
