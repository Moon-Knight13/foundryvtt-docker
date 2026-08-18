import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArt, GENERIC_ART_DIR } from './art-resolve.mjs';

// A trimmed art-map.json shape — the real one lives in content/reference/.
const MAP = {
  byName: {
    Goblin: { icon: 'caro-asercion/goblin.svg', artist: 'Caro Asercion' },
    Wolf: { icon: 'lorc/wolf-head.svg', artist: 'Lorc' },
  },
  byType: {
    humanoid: { icon: 'delapouite/person.svg', artist: 'Delapouite' },
    beast: { icon: 'lorc/paw-print.svg', artist: 'Lorc' },
  },
};

test('an explicit image: always wins, verbatim', () => {
  const r = resolveArt(
    {
      name: 'Goblin',
      type: 'humanoid',
      image: 'DnD/My Game/Assets/Tokens/boss.webp',
      source: 'SRD 5.1',
    },
    MAP,
  );
  assert.equal(r.tier, 'explicit');
  assert.equal(r.src, 'DnD/My Game/Assets/Tokens/boss.webp');
});

test('a curated name match resolves to the fetched icon, Data-relative', () => {
  const r = resolveArt({ name: 'Goblin', type: 'humanoid', source: 'SRD 5.1' }, MAP);
  assert.equal(r.tier, 'exact');
  assert.equal(r.src, `${GENERIC_ART_DIR}/caro-asercion/goblin.svg`);
  assert.equal(r.artist, 'Caro Asercion', 'CC-BY needs the artist carried through');
});

test('a mook falls back to its creature-type silhouette', () => {
  // source: means the fence inherits a published SRD creature — a mook. A
  // generic outline is acceptable there; the table needs SOME token.
  const r = resolveArt({ name: 'Cult Fanatic', type: 'humanoid', source: 'SRD 5.1' }, MAP);
  assert.equal(r.tier, 'type');
  assert.equal(r.src, `${GENERIC_ART_DIR}/delapouite/person.svg`);
});

test('a bespoke named NPC never inherits a silhouette', () => {
  // No source: means someone authored this character. Dressing them in a
  // generic outline would hide exactly the gap the gate exists to catch.
  const r = resolveArt({ name: 'Zanna the Blade', type: 'humanoid' }, MAP);
  assert.equal(r.tier, 'none');
  assert.equal(r.src, null);
});

test('a bespoke NPC still gets a curated match when the name IS a mapped creature', () => {
  const r = resolveArt({ name: 'Wolf', type: 'beast' }, MAP);
  assert.equal(r.tier, 'exact');
});

test('art_required: true makes a mook as strict as a named NPC', () => {
  const r = resolveArt(
    { name: 'The Lamia', type: 'monstrosity', source: 'SRD 5.1', art_required: true },
    MAP,
  );
  assert.equal(r.tier, 'none', 'a silhouette must not satisfy an explicit demand for art');
});

test('art_required: false lets a bespoke NPC accept the silhouette', () => {
  const r = resolveArt({ name: 'Nameless Guard 3', type: 'humanoid', art_required: false }, MAP);
  assert.equal(r.tier, 'type');
});

test('an unmapped type resolves to none, not to a wrong icon', () => {
  const r = resolveArt({ name: 'Weird Thing', type: 'custom', source: 'SRD 5.2' }, MAP);
  assert.equal(r.tier, 'none');
});

test('the disabled raster tier stays disabled until measured', () => {
  // A raster block is honoured only when explicitly enabled — the source is
  // firewall-blocked until the operator rebuilds with the new allowlist.
  const withRaster = {
    ...MAP,
    raster: { enabled: false, byName: { Goblin: { src: 'https://example.test/goblin.png' } } },
  };
  const off = resolveArt({ name: 'Goblin', type: 'humanoid', source: 'SRD 5.1' }, withRaster);
  assert.equal(off.tier, 'exact', 'disabled raster must not shadow the curated map');

  const on = resolveArt(
    { name: 'Goblin', type: 'humanoid', source: 'SRD 5.1' },
    { ...withRaster, raster: { ...withRaster.raster, enabled: true } },
  );
  assert.equal(on.tier, 'raster');
  assert.equal(on.src, 'https://example.test/goblin.png');
});
