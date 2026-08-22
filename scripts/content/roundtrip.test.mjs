import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { main, docId } from './build.mjs';
import { CUE_FLAG_SCOPE } from './cue.mjs';

const MODULE_ID = 'test-content';

async function workspace(prefix) {
  const work = await mkdtemp(path.join(tmpdir(), prefix));
  const srcRoot = path.join(work, 'src');
  const distRoot = path.join(work, 'dist');
  const configPath = path.join(work, 'content.config.json');
  await writeFile(
    configPath,
    JSON.stringify({ id: MODULE_ID, title: 'Test Content', system: 'dnd5e' }),
  );
  return { work, srcRoot, distRoot, configPath };
}

test('build compiles packs that round-trip via extractPack', async () => {
  const { work, srcRoot, distRoot, configPath } = await workspace('fvtt-content-');
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'journals', 'quest.json'),
    JSON.stringify({
      name: 'The Sunken Bell',
      pages: [
        {
          name: 'Hook',
          type: 'text',
          title: { show: true, level: 1 },
          text: { content: '<p>Bell tolls beneath the harbor.</p>', format: 1 },
          sort: 0,
        },
      ],
    }),
  );

  const { counts, config } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.journals, 1);
  assert.equal(config.id, MODULE_ID);

  const moduleDir = path.join(distRoot, MODULE_ID);
  const manifest = JSON.parse(await readFile(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(manifest.id, MODULE_ID);
  assert.ok(manifest.packs.every(p => p.system === 'dnd5e'));

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(moduleDir, 'packs', 'journals'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'The Sunken Bell');
  assert.match(doc._id, /^[a-z0-9]{16}$/);
});

test('roll tables round-trip with embedded results', async () => {
  const { work, srcRoot, distRoot, configPath } = await workspace('fvtt-tables-');
  await mkdir(path.join(srcRoot, 'tables'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'tables', 'hollow-rumours.json'),
    JSON.stringify({
      name: 'Hollow Rumours',
      formula: '1d2',
      results: [
        { type: 'text', description: 'A ship came in flying no flag.', range: [1, 1], weight: 1 },
        {
          type: 'text',
          description: 'The bell tolled twice at midnight.',
          range: [2, 2],
          weight: 1,
        },
      ],
    }),
  );

  const { counts } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.tables, 1);

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(distRoot, MODULE_ID, 'packs', 'tables'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'Hollow Rumours');
  assert.equal(doc.results.length, 2);
  assert.match(doc.results[0]._id, /^[a-z0-9]{16}$/);
});

test('scenes round-trip with embedded walls and lights', async () => {
  const { work, srcRoot, distRoot, configPath } = await workspace('fvtt-scenes-');
  await mkdir(path.join(srcRoot, 'scenes'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'scenes', 'signal-tower.json'),
    JSON.stringify({
      name: 'The Signal Tower',
      width: 1600,
      height: 1600,
      grid: { type: 1, size: 100, distance: 5, units: 'ft' },
      walls: [{ c: [0, 0, 1600, 0] }, { c: [1600, 0, 1600, 1600], door: 1, ds: 0 }],
      lights: [{ x: 800, y: 800, config: { dim: 30, bright: 15, color: '#ffdca8', alpha: 0.5 } }],
      flags: {
        [CUE_FLAG_SCOPE]: {
          audio: { cue: 'as the beacon lights', command: '/play tower-list' },
        },
      },
    }),
  );

  const { counts } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.scenes, 1);

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(distRoot, MODULE_ID, 'packs', 'scenes'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'The Signal Tower');
  // The EMBEDDED change must give every wall/light a stable 16-hex id through
  // the LevelDB roundtrip, else the CLI drops them.
  assert.equal(doc.walls.length, 2);
  assert.match(doc.walls[0]._id, /^[a-z0-9]{16}$/);
  assert.equal(doc.lights.length, 1);
  assert.match(doc.lights[0]._id, /^[a-z0-9]{16}$/);

  // The ambience cue rides to the table on the scene itself. If packing drops
  // an unknown flag scope, the Cue reminder macro goes quiet — and a reminder
  // that fails silently is worse than no reminder, because you stop checking.
  assert.deepEqual(doc.flags[CUE_FLAG_SCOPE].audio, {
    cue: 'as the beacon lights',
    command: '/play tower-list',
  });
});

test('build fails loudly on invalid source', async () => {
  const { srcRoot, distRoot, configPath } = await workspace('fvtt-content-bad-');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await writeFile(path.join(srcRoot, 'actors', 'broken.json'), JSON.stringify({ type: 'npc' }));
  await assert.rejects(
    () => main({ srcRoot, distRoot, configPath }),
    /missing required field "name"/,
  );
});

test('build fails on broken @UUID cross-link', async () => {
  const { srcRoot, distRoot, configPath } = await workspace('fvtt-links-');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'actors', 'rook-vantle.json'),
    JSON.stringify({ name: 'Rook Vantle', type: 'npc' }),
  );

  const goodId = docId('actors/rook-vantle.json');
  const badId = 'f'.repeat(16);
  const journal = id =>
    JSON.stringify({
      name: 'Primer',
      pages: [
        {
          name: 'P',
          type: 'text',
          text: {
            content: `<p>@UUID[Compendium.${MODULE_ID}.actors.Actor.${id}]{Rook Vantle}</p>`,
            format: 1,
          },
        },
      ],
    });

  await writeFile(path.join(srcRoot, 'journals', 'primer.json'), journal(badId));
  await assert.rejects(() => main({ srcRoot, distRoot, configPath }), /broken @UUID link/);

  await writeFile(path.join(srcRoot, 'journals', 'primer.json'), journal(goodId));
  const { counts } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.journals, 1);
});

test('image journal pages survive the build with src and ownership intact', async () => {
  // The whole point of handout.mjs: a page Foundry renders as a picture the GM
  // can "Show to Players". If compilePack mangles `src` or the ownership level,
  // the art silently stops being shareable.
  const { srcRoot, distRoot, configPath } = await workspace('fvtt-image-page-');
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'journals', 'ransom-note-art.json'),
    JSON.stringify({
      name: 'The Ransom Note — Art',
      ownership: { default: 2 },
      pages: [
        {
          name: 'Drawn in charcoal',
          type: 'image',
          src: 'DnD/03 Oneshots/My Game/Assets/Art/crooked-map.webp',
          image: { caption: 'Drawn in charcoal' },
          title: { show: true, level: 1 },
          ownership: { default: 2 },
          sort: 100,
        },
      ],
    }),
  );

  await main({ srcRoot, distRoot, configPath });

  const outDir = path.join(distRoot, 'extract-image');
  await mkdir(outDir, { recursive: true });
  // NOTE: the pack DIRECTORY is named for the source folder ('journals');
  // 'journal' is only the LevelDB sublevel. Pointing extractPack at a path that
  // does not exist creates an empty database and fails with a misleading
  // "Iterator is not open".
  await extractPack(path.join(distRoot, MODULE_ID, 'packs', 'journals'), outDir, { log: false });

  const files = (await readdir(outDir)).filter(f => f.endsWith('.json'));
  const docs = await Promise.all(
    files.map(async f => JSON.parse(await readFile(path.join(outDir, f), 'utf8'))),
  );
  const journal = docs.find(d => d.name === 'The Ransom Note — Art');
  assert.ok(journal, 'the art journal round-tripped');

  const page = journal.pages[0];
  assert.equal(page.type, 'image');
  // A Data-relative path with spaces is exactly what the vault mount produces.
  assert.equal(page.src, 'DnD/03 Oneshots/My Game/Assets/Art/crooked-map.webp');
  assert.equal(page.image.caption, 'Drawn in charcoal');
  assert.equal(page.ownership.default, 2, 'players can reopen it');
  assert.ok(page._id, 'build assigned a stable id');
});
