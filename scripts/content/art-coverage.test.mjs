import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyArt, audit, describeCoverage } from './art-coverage.mjs';

test('classifyArt tells real art, silhouettes, the placeholder, and nothing apart', () => {
  assert.equal(classifyArt('DnD/My Game/Assets/Tokens/boss.webp'), 'real');
  assert.equal(classifyArt('DnD/06 Assets/Tokens/generic/lorc/wolf-head.svg'), 'generic');
  assert.equal(classifyArt('icons/svg/mystery-man.svg'), 'placeholder');
  assert.equal(classifyArt(undefined), 'missing');
  assert.equal(classifyArt(''), 'missing');
  // Other core icons are deliberate choices (map pins use icons/svg/book.svg).
  assert.equal(classifyArt('icons/svg/book.svg'), 'real');
});

async function srcTree(docs) {
  const dir = await mkdtemp(path.join(tmpdir(), 'art-cov-'));
  for (const [rel, doc] of Object.entries(docs)) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), JSON.stringify(doc));
  }
  return dir;
}

test('audit reports every art slot and fails the blank actor', async () => {
  const src = await srcTree({
    'actors/boss.json': {
      name: 'Boss',
      img: 'DnD/G/Assets/Tokens/boss.webp',
      prototypeToken: { texture: { src: 'DnD/G/Assets/Tokens/boss.webp' } },
    },
    'actors/mook.json': {
      name: 'Mook',
      img: 'DnD/06 Assets/Tokens/generic/delapouite/person.svg',
      prototypeToken: { texture: { src: 'DnD/06 Assets/Tokens/generic/delapouite/person.svg' } },
    },
    'actors/blank.json': {
      name: 'Blank',
      img: 'icons/svg/mystery-man.svg',
      prototypeToken: { texture: { src: 'icons/svg/mystery-man.svg' } },
    },
    'scenes/cove.json': { name: 'Cove', background: { src: 'DnD/G/Assets/Maps/cove.png' } },
    'journals/handout-art.json': {
      name: 'Handout — Art',
      pages: [{ name: 'p1', type: 'image', src: 'DnD/G/Assets/Art/map.webp' }],
    },
  });

  const report = await audit(src);
  assert.equal(report.buckets.real, 4, 'portrait+token, scene, journal page');
  assert.equal(report.buckets.generic, 2);
  assert.equal(report.buckets.placeholder, 2);
  assert.equal(report.failures.length, 1, 'one failing document, not one per slot');
  assert.match(report.failures[0], /actors\/blank\.json/);
  assert.match(report.failures[0], /placeholder/);
});

test('a scene with no background is a failure, not a bucket', async () => {
  const src = await srcTree({ 'scenes/void.json': { name: 'Void' } });
  const report = await audit(src);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /scenes\/void\.json/);
});

test('with a vault, a Data-relative path must actually resolve to a file', async () => {
  const vault = await mkdtemp(path.join(tmpdir(), 'art-vault-'));
  await mkdir(path.join(vault, 'G', 'Assets', 'Tokens'), { recursive: true });
  await writeFile(path.join(vault, 'G', 'Assets', 'Tokens', 'real.webp'), 'x');

  const src = await srcTree({
    'actors/real.json': {
      name: 'Real',
      img: 'DnD/G/Assets/Tokens/real.webp',
      prototypeToken: { texture: { src: 'DnD/G/Assets/Tokens/real.webp' } },
    },
    'actors/dangling.json': {
      name: 'Dangling',
      img: 'DnD/G/Assets/Tokens/gone.webp',
      prototypeToken: { texture: { src: 'DnD/G/Assets/Tokens/gone.webp' } },
    },
  });

  const report = await audit(src, { vault });
  assert.equal(report.buckets.unresolvable, 2);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /dangling\.json/);
  assert.match(report.failures[0], /does not exist/);
});

test('without a vault, Data-relative paths are trusted, not failed', async () => {
  // CI has no vault mount; a green report there must not promise resolution.
  const src = await srcTree({
    'actors/x.json': {
      name: 'X',
      img: 'DnD/G/Assets/Tokens/unverifiable.webp',
      prototypeToken: { texture: { src: 'DnD/G/Assets/Tokens/unverifiable.webp' } },
    },
  });
  const report = await audit(src);
  assert.equal(report.failures.length, 0);
  assert.equal(report.buckets.unchecked, 2);
});

test('describeCoverage states the buckets and stays quiet about empty ones', () => {
  const text = describeCoverage({
    buckets: { real: 7, generic: 2, placeholder: 0, missing: 0, unchecked: 0, unresolvable: 0 },
    failures: [],
  });
  assert.match(text, /7 .*real art/);
  assert.match(text, /2 .*generic silhouette/);
  assert.doesNotMatch(text, /placeholder/);
  assert.doesNotMatch(text, /unresolvable/);
});
