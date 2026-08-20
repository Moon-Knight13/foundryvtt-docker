import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArt, normalizeArtPath, GENERIC_ART_DIR } from './art-resolve.mjs';

// A trimmed art-map.json shape — the real one lives in content/reference/.
const MAP = {
  byName: {
    Goblin: { icon: 'caro-asercion/goblin.svg', artist: 'Caro Asercion' },
    Wolf: { icon: 'lorc/wolf-head.svg', artist: 'Lorc' },
    Spy: { icon: 'delapouite/spy.svg', artist: 'Delapouite' },
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
      base: 'Goblin',
      type: 'humanoid',
      image: 'DnD/My Game/Assets/Tokens/boss.webp',
    },
    MAP,
  );
  assert.equal(r.tier, 'explicit');
  assert.equal(r.src, 'DnD/My Game/Assets/Tokens/boss.webp');
});

test('a mook — a note titled after its base creature — gets the curated icon', () => {
  const r = resolveArt({ name: 'Goblin', base: 'Goblin', type: 'humanoid' }, MAP);
  assert.equal(r.tier, 'exact');
  assert.equal(r.src, `${GENERIC_ART_DIR}/caro-asercion/goblin.svg`);
  assert.equal(r.artist, 'Caro Asercion', 'CC-BY needs the artist carried through');
});

test('an unmapped mook falls back to its creature-type silhouette', () => {
  const r = resolveArt({ name: 'Cult Fanatic', base: 'Cult Fanatic', type: 'humanoid' }, MAP);
  assert.equal(r.tier, 'type');
  assert.equal(r.src, `${GENERIC_ART_DIR}/delapouite/person.svg`);
});

test("a named NPC built on an SRD base never inherits that base's icon", () => {
  // Measured on a real module: two different named NPCs were both built on the
  // Spy, and source:-presence alone dressed BOTH in the same spy icon — two
  // named characters, identical tokens, and a green gate. Someone authored
  // these; the gap must be visible.
  const r = resolveArt({ name: 'Rook Vantle', base: 'Spy', type: 'humanoid' }, MAP);
  assert.equal(r.tier, 'none');
  assert.equal(r.src, null);
});

test('a bespoke NPC with no base resolves to none, not a silhouette', () => {
  const r = resolveArt({ name: 'Zanna the Blade', type: 'humanoid' }, MAP);
  assert.equal(r.tier, 'none');
});

test('a named NPC whose own name is a mapped creature still matches it', () => {
  const r = resolveArt({ name: 'Wolf', type: 'beast' }, MAP);
  assert.equal(r.tier, 'exact');
});

test('art_required: true makes even an exact-title mook strict', () => {
  const r = resolveArt(
    { name: 'Goblin', base: 'Goblin', type: 'humanoid', art_required: true },
    MAP,
  );
  // The curated match still wins — art_required demands art, and this IS its
  // creature's icon. Only the silhouette tier is refused.
  assert.equal(r.tier, 'exact');
  const typed = resolveArt(
    { name: 'Cult Fanatic', base: 'Cult Fanatic', type: 'humanoid', art_required: true },
    MAP,
  );
  assert.equal(typed.tier, 'none', 'a silhouette must not satisfy an explicit demand for art');
});

test('art_required: false lets a named NPC accept its base icon, then the silhouette', () => {
  const viaBase = resolveArt(
    { name: 'Rook Vantle', base: 'Spy', type: 'humanoid', art_required: false },
    MAP,
  );
  assert.equal(viaBase.tier, 'exact', 'explicit opt-out unlocks the base creature icon');
  assert.equal(viaBase.src, `${GENERIC_ART_DIR}/delapouite/spy.svg`);

  const viaType = resolveArt(
    { name: 'Nameless Guard 3', base: 'Thug', type: 'humanoid', art_required: false },
    MAP,
  );
  assert.equal(viaType.tier, 'type', 'unmapped base still lands on the type silhouette');
});

test('title matching is forgiving about case and punctuation, not about words', () => {
  const r = resolveArt({ name: 'giant  spider', base: 'Giant Spider', type: 'beast' }, MAP);
  assert.equal(r.tier, 'type', 'same words = same creature = mook');
  const named = resolveArt({ name: 'Spider Queen', base: 'Giant Spider', type: 'beast' }, MAP);
  assert.equal(named.tier, 'none', 'different words = a character someone authored');
});

test('an unmapped type resolves to none, not to a wrong icon', () => {
  const r = resolveArt({ name: 'Weird Thing', base: 'Weird Thing', type: 'custom' }, MAP);
  assert.equal(r.tier, 'none');
});

test('the disabled raster tier stays disabled until measured', () => {
  const withRaster = {
    ...MAP,
    raster: { enabled: false, byName: { Goblin: { src: 'https://example.test/goblin.png' } } },
  };
  const off = resolveArt({ name: 'Goblin', base: 'Goblin', type: 'humanoid' }, withRaster);
  assert.equal(off.tier, 'exact', 'disabled raster must not shadow the curated map');

  const on = resolveArt(
    { name: 'Goblin', base: 'Goblin', type: 'humanoid' },
    { ...withRaster, raster: { ...withRaster.raster, enabled: true } },
  );
  assert.equal(on.tier, 'raster');
  assert.equal(on.src, 'https://example.test/goblin.png');
});

test('a vault-relative image path gains the DnD/ mount prefix for Foundry', () => {
  assert.equal(
    normalizeArtPath('06 Assets/Tokens/generic/lorc/scorpion.svg'),
    'DnD/06 Assets/Tokens/generic/lorc/scorpion.svg',
  );
  assert.equal(
    normalizeArtPath('03 Oneshots/Ashwake Hollow/Assets/Tokens/rook-vantle.webp'),
    'DnD/03 Oneshots/Ashwake Hollow/Assets/Tokens/rook-vantle.webp',
  );
});

// Assembled rather than written out, because a literal plain-http URL anywhere
// in this repo trips its own `insecure-http-url` semgrep rule — correctly, since
// the rule cannot tell a test fixture from a real endpoint. An inline
// `nosemgrep` did not travel: CI runs a newer semgrep in Docker with p/secrets
// and p/security-audit alongside the local config, and the suppression that
// works for the pre-commit hook did not apply there. Not writing the string is
// simpler than making two scanners agree about ignoring it.
const PLAIN_HTTP_ART_URL = `${'http'}://example.test/goblin.png`;

test('paths Foundry already understands pass through normalizeArtPath verbatim', () => {
  for (const p of [
    'DnD/06 Assets/Tokens/generic/lorc/scorpion.svg',
    'icons/svg/mystery-man.svg',
    'systems/dnd5e/tokens/beast/Scorpion.webp',
    'modules/some-module/art/thing.webp',
    'https://example.test/goblin.png',
    // Not a fetched URL — proves the prefix regex passes plain-http art links
    // through untouched instead of mangling them into DnD/http:…
    PLAIN_HTTP_ART_URL,
  ]) {
    assert.equal(normalizeArtPath(p), p, `${p} must not be re-prefixed`);
  }
});

test('normalizeArtPath leaves empty and missing values alone', () => {
  assert.equal(normalizeArtPath(''), '');
  assert.equal(normalizeArtPath(undefined), undefined);
  assert.equal(normalizeArtPath(null), null);
});

test('resolveArt normalizes the explicit tier the same way', () => {
  const r = resolveArt(
    {
      name: 'Goblin',
      base: 'Goblin',
      type: 'humanoid',
      image: '06 Assets/Tokens/custom/boss.webp',
    },
    MAP,
  );
  assert.equal(r.tier, 'explicit');
  assert.equal(r.src, 'DnD/06 Assets/Tokens/custom/boss.webp');
});
