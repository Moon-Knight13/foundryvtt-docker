import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { main, MODULE_ID } from './build.mjs';

test('build compiles packs that round-trip via extractPack', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'fvtt-content-'));
  const srcRoot = path.join(work, 'src');
  const distRoot = path.join(work, 'dist');
  await mkdir(path.join(srcRoot, 'journals'), { recursive: true });
  await writeFile(
    path.join(srcRoot, 'journals', 'quest.json'),
    JSON.stringify({
      name: 'The Sunken Bell',
      pages: [{ name: 'Hook', type: 'text', title: { show: true, level: 1 }, text: { content: '<p>Bell tolls beneath the harbor.</p>', format: 1 }, sort: 0 }],
    })
  );

  const { counts } = await main({ srcRoot, distRoot });
  assert.equal(counts.journals, 1);

  const moduleDir = path.join(distRoot, MODULE_ID);
  const manifest = JSON.parse(await readFile(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(manifest.id, MODULE_ID);

  const outDir = path.join(work, 'unpacked');
  await extractPack(path.join(moduleDir, 'packs', 'journals'), outDir, { log: false });
  const files = await readdir(outDir);
  assert.equal(files.length, 1);
  const doc = JSON.parse(await readFile(path.join(outDir, files[0]), 'utf8'));
  assert.equal(doc.name, 'The Sunken Bell');
  assert.match(doc._id, /^[a-z0-9]{16}$/);
});

test('build fails loudly on invalid source', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'fvtt-content-bad-'));
  const srcRoot = path.join(work, 'src');
  await mkdir(path.join(srcRoot, 'actors'), { recursive: true });
  await writeFile(path.join(srcRoot, 'actors', 'broken.json'), JSON.stringify({ type: 'npc' }));
  await assert.rejects(() => main({ srcRoot, distRoot: path.join(work, 'dist') }), /missing required field "name"/);
});
