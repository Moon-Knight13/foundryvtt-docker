import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rawUrl, attribution, fetchIcons } from './art-fetch.mjs';

const MAP = {
  source: 'game-icons/icons@82d948812bfe3f269ef8f731dcdb07b08160edc4',
  licence: 'CC-BY-3.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
  byName: {
    Goblin: { icon: 'caro-asercion/goblin.svg', artist: 'Caro Asercion' },
    Wolf: { icon: 'lorc/wolf-head.svg', artist: 'Lorc' },
  },
  byType: {
    humanoid: { icon: 'delapouite/person.svg', artist: 'Delapouite' },
  },
};

test('rawUrl pins the fetch to the commit the map was curated against', () => {
  assert.equal(
    rawUrl(MAP.source, 'lorc/wolf-head.svg'),
    'https://raw.githubusercontent.com/game-icons/icons/82d948812bfe3f269ef8f731dcdb07b08160edc4/lorc/wolf-head.svg',
  );
});

test('rawUrl refuses an unpinned source rather than fetching a moving target', () => {
  assert.throws(() => rawUrl('game-icons/icons', 'lorc/wolf-head.svg'), /pinned/);
});

test('fetchIcons lands every mapped icon under its artist directory', async () => {
  const dest = await mkdtemp(path.join(tmpdir(), 'art-fetch-'));
  const fetched = [];
  const fetchFn = async url => {
    fetched.push(url);
    return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(`<svg>${url}</svg>`).buffer,
    };
  };

  const stats = await fetchIcons(MAP, dest, { fetchFn });
  assert.equal(stats.fetched, 3);
  assert.equal(stats.skipped, 0);
  assert.deepEqual(stats.failed, []);
  const files = await readdir(dest, { recursive: true });
  assert.ok(files.includes(path.join('caro-asercion', 'goblin.svg')));
  assert.ok(files.includes(path.join('lorc', 'wolf-head.svg')));
  assert.ok(files.includes(path.join('delapouite', 'person.svg')));
});

test('a second run is a no-op — existing files are never re-fetched', async () => {
  const dest = await mkdtemp(path.join(tmpdir(), 'art-fetch-'));
  const fetchFn = async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode('x').buffer,
  });
  await fetchIcons(MAP, dest, { fetchFn });

  let calls = 0;
  const second = await fetchIcons(MAP, dest, {
    fetchFn: async () => {
      calls++;
      throw new Error('should not be called');
    },
  });
  assert.equal(calls, 0);
  assert.equal(second.skipped, 3);
  assert.equal(second.fetched, 0);
});

test('one failed download does not abandon the rest', async () => {
  const dest = await mkdtemp(path.join(tmpdir(), 'art-fetch-'));
  const fetchFn = async url =>
    url.includes('goblin')
      ? { ok: false, status: 404 }
      : { ok: true, arrayBuffer: async () => new TextEncoder().encode('x').buffer };

  const stats = await fetchIcons(MAP, dest, { fetchFn });
  assert.equal(stats.fetched, 2);
  assert.equal(stats.failed.length, 1);
  assert.match(stats.failed[0], /goblin/);
});

test('attribution names every artist, the licence, and the pinned source', () => {
  const text = attribution(MAP);
  assert.match(text, /CC-BY-3\.0/);
  assert.match(text, /game-icons\/icons@82d9488/);
  assert.match(text, /Caro Asercion/);
  assert.match(text, /Lorc/);
  assert.match(text, /Delapouite/);
  // One line per artist, not one per icon — 108 icon lines would drown the point.
  assert.equal((text.match(/Caro Asercion/g) ?? []).length, 1);
});
