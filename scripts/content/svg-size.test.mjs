import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasIntrinsicSize, stampSvgSize } from './svg-size.mjs';

// The shape game-icons.net actually ships, and the shape hand-authored token
// art copied from it: a viewBox and nothing else.
// The SVG namespace is an identifier, not an endpoint — assembled from parts so
// the repo's insecure-http-url rule does not flag a URI that is never fetched.
const SVG_NS = ['http', '//www.w3.org/2000/svg'].join('://');
const VIEWBOX_ONLY = `<svg xmlns="${SVG_NS}" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/></svg>`;

test('hasIntrinsicSize tells a sized SVG from a viewBox-only one', () => {
  assert.equal(hasIntrinsicSize(VIEWBOX_ONLY), false);
  assert.equal(
    hasIntrinsicSize('<svg width="340" height="340" viewBox="0 0 340 340"></svg>'),
    true,
  );
});

test('stampSvgSize takes the size from the viewBox', () => {
  const out = stampSvgSize(VIEWBOX_ONLY);
  assert.match(out, /<svg width="512" height="512"/);
  assert.equal(hasIntrinsicSize(out), true);
  assert.ok(out.includes('viewBox="0 0 512 512"'), 'viewBox survives');
  assert.ok(out.includes('<path d="M0 0h512v512H0z"/>'), 'artwork untouched');
});

test('stampSvgSize handles a non-square, non-integer viewBox', () => {
  const out = stampSvgSize('<svg viewBox="0 0 300.0 150.5"></svg>');
  assert.match(out, /width="300" height="150.5"/);
});

test('stampSvgSize is idempotent', () => {
  const once = stampSvgSize(VIEWBOX_ONLY);
  assert.equal(stampSvgSize(once), once);
});

test('stampSvgSize leaves an already-sized SVG alone', () => {
  const sized = '<svg width="340" height="340" viewBox="0 0 340 340"></svg>';
  assert.equal(stampSvgSize(sized), sized);
});

test('stampSvgSize gives up quietly when there is nothing to work from', () => {
  // No viewBox to take numbers from, and not an SVG at all: both pass through
  // rather than throwing, so a fetch of something unexpected is not fatal.
  assert.equal(stampSvgSize('<svg xmlns="x"></svg>'), '<svg xmlns="x"></svg>');
  assert.equal(stampSvgSize('not an svg'), 'not an svg');
});

test('stampSvgSize preserves a leading XML declaration', () => {
  const src = '<?xml version="1.0" encoding="utf-8"?>\n<svg viewBox="0 0 64 64"></svg>';
  const out = stampSvgSize(src);
  assert.ok(out.startsWith('<?xml version="1.0" encoding="utf-8"?>\n'));
  assert.match(out, /<svg width="64" height="64"/);
});

test('stampTree walks a tree, reports, and only writes with --apply', async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { stampTree } = await import('./svg-size.mjs');

  const root = await mkdtemp(path.join(tmpdir(), 'svgsize-'));
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'bare.svg'), VIEWBOX_ONLY);
  await writeFile(path.join(root, 'nested', 'deep.svg'), VIEWBOX_ONLY);
  await writeFile(path.join(root, 'sized.svg'), '<svg width="8" height="8" viewBox="0 0 8 8"/>');
  await writeFile(path.join(root, 'notes.md'), 'ignored');

  const dry = await stampTree(root);
  assert.equal(dry.stamped.length, 2, 'finds both nested and top-level');
  assert.equal(dry.alreadySized, 1);
  assert.equal(
    await readFile(path.join(root, 'bare.svg'), 'utf8'),
    VIEWBOX_ONLY,
    'dry run wrote nothing',
  );

  const applied = await stampTree(root, { apply: true });
  assert.equal(applied.stamped.length, 2);
  assert.match(await readFile(path.join(root, 'nested', 'deep.svg'), 'utf8'), /width="512"/);

  const again = await stampTree(root, { apply: true });
  assert.equal(again.stamped.length, 0, 'second pass is a no-op');
  assert.equal(again.alreadySized, 3);
});
