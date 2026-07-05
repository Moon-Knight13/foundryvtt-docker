import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { main, docId } from './build.mjs';

const MODULE_ID = 'test-content';

async function workspace(prefix) {
  const work = await mkdtemp(path.join(tmpdir(), prefix));
  const srcRoot = path.join(work, 'src');
  const distRoot = path.join(work, 'dist');
  const configPath = path.join(work, 'content.config.json');
  await writeFile(configPath, JSON.stringify({ id: MODULE_ID, title: 'Test Content', system: 'dnd5e' }));
  return { work, srcRoot, distRoot, configPath };
}

test('build compiles packs that round-trip via extractPack', async () => {
  const { work, srcRoot, distRoot, configPath } = await workspace('fvtt-content-');
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'journals', 'quest.json'),
    JSON.stringify({
      name: 'The Sunken Bell',
      pages: [{ name: 'Hook', type: 'text', title: { show: true, level: 1 }, text: { content: '<p>Bell tolls beneath the harbor.</p>', format: 1 }, sort: 0 }],
    })
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
    path.join(srcRoot, 'tables', 'harbor-rumors.json'),
    JSON.stringify({
      name: 'Harbor Rumors',
      formula: '1d2',
      results: [
        { type: 'text', description: 'A ship came in flying no flag.', range: [1, 1], weight: 1 },
        { type: 'text', description: 'The bell tolled twice at midnight.', range: [2, 2], weight: 1 },
      ],
    })
  );

  const { counts } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.tables, 1);

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(distRoot, MODULE_ID, 'packs', 'tables'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'Harbor Rumors');
  assert.equal(doc.results.length, 2);
  assert.match(doc.results[0]._id, /^[a-z0-9]{16}$/);
});

test('build fails loudly on invalid source', async () => {
  const { srcRoot, distRoot, configPath } = await workspace('fvtt-content-bad-');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await writeFile(path.join(srcRoot, 'actors', 'broken.json'), JSON.stringify({ type: 'npc' }));
  await assert.rejects(() => main({ srcRoot, distRoot, configPath }), /missing required field "name"/);
});

test('build fails on broken @UUID cross-link', async () => {
  const { srcRoot, distRoot, configPath } = await workspace('fvtt-links-');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(path.join(srcRoot, 'actors', 'vela.json'), JSON.stringify({ name: 'Vela', type: 'npc' }));

  const goodId = docId('actors/vela.json');
  const badId = 'f'.repeat(16);
  const journal = id => JSON.stringify({
    name: 'Primer',
    pages: [{ name: 'P', type: 'text', text: { content: `<p>@UUID[Compendium.${MODULE_ID}.actors.Actor.${id}]{Vela}</p>`, format: 1 } }],
  });

  await writeFile(path.join(srcRoot, 'journals', 'primer.json'), journal(badId));
  await assert.rejects(() => main({ srcRoot, distRoot, configPath }), /broken @UUID link/);

  await writeFile(path.join(srcRoot, 'journals', 'primer.json'), journal(goodId));
  const { counts } = await main({ srcRoot, distRoot, configPath });
  assert.equal(counts.journals, 1);
});
