import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  distill,
  srdIndex,
  parseArgs,
  copyArt,
  assertDataDir,
  explainArtError,
  PACKS,
} from './srd-cache.mjs';

// Trimmed from the real dnd5e.actors24 "Bandit" document as extractPack yields
// it — i.e. STORED, not derived. Note ac.flat is null and movement.walk is the
// string "30"; both are real, and both are why distill normalises.
const BANDIT = {
  _id: 'mmBandit00000000',
  name: 'Bandit',
  type: 'npc',
  img: 'systems/dnd5e/tokens/humanoid/Bandit.webp',
  system: {
    abilities: {
      str: { value: 11 },
      dex: { value: 12 },
      con: { value: 12 },
      int: { value: 10 },
      wis: { value: 10 },
      cha: { value: 10 },
    },
    attributes: {
      ac: { flat: null, calc: 'default' },
      hp: { value: 11, max: 11, formula: '2d8 + 2' },
      movement: { walk: '30', fly: 0, swim: 0, units: null, hover: false },
      senses: {
        units: null,
        special: '',
        ranges: { darkvision: null, blindsight: null, tremorsense: null, truesight: null },
      },
    },
    details: { cr: 0.125, type: { value: 'humanoid' } },
    traits: { size: 'med', languages: { value: ['common', 'cant'] } },
  },
  prototypeToken: { texture: { src: 'systems/dnd5e/tokens/humanoid/Bandit.webp' } },
};

// A natural-armour monster: AC is stored flat, and it has real senses.
const LAMIA = {
  name: 'Lamia',
  img: 'systems/dnd5e/tokens/monstrosity/Lamia.webp',
  system: {
    abilities: {
      str: { value: 16 },
      dex: { value: 13 },
      con: { value: 15 },
      int: { value: 14 },
      wis: { value: 15 },
      cha: { value: 16 },
    },
    attributes: {
      ac: { flat: 13, calc: 'natural' },
      hp: { max: 97, formula: '13d10 + 26' },
      movement: { walk: 30 },
      senses: { ranges: { darkvision: 60, blindsight: null } },
    },
    details: { cr: 4, type: { value: 'monstrosity' } },
    traits: { size: 'lg', languages: { value: ['abyssal', 'common'] } },
  },
  prototypeToken: { texture: { src: 'systems/dnd5e/tokens/monstrosity/Lamia.webp' } },
};

test('distill reads stored stats and normalises string/number drift', () => {
  const d = distill(BANDIT);
  assert.equal(d.name, 'Bandit');
  assert.equal(d.hp, 11);
  assert.equal(d.hpFormula, '2d8 + 2');
  assert.equal(d.cr, 0.125);
  assert.equal(d.size, 'med');
  assert.equal(d.type, 'humanoid');
  assert.deepEqual(d.abilities, { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 });
  // movement.walk is the string "30" in the stored document.
  assert.deepEqual(d.speed, { walk: 30 });
  assert.deepEqual(d.languages, ['common', 'cant']);
});

test('distill leaves AC undefined when the system derives it from equipment', () => {
  const d = distill(BANDIT);
  // Bandit's real AC (12) comes from equipped Leather Armor + Dex at runtime.
  // Reporting 0 here would make every armoured monster look like a mismatch.
  assert.equal(d.ac, undefined);
  assert.equal(d.acCalc, 'default');
  // A natural-armour monster does store it, and must be checkable.
  assert.equal(distill(LAMIA).ac, 13);
  assert.equal(distill(LAMIA).acCalc, 'natural');
});

test('distill drops zero and null speeds/senses rather than recording them', () => {
  const d = distill(BANDIT);
  assert.ok(!('fly' in d.speed), 'fly 0 must not be recorded');
  assert.deepEqual(d.senses, {}, 'null sense ranges must not be recorded');
  assert.deepEqual(distill(LAMIA).senses, { darkvision: 60 });
});

test('distill carries token art for both surfaces', () => {
  const d = distill(BANDIT);
  assert.equal(d.img, 'systems/dnd5e/tokens/humanoid/Bandit.webp');
  assert.equal(d.tokenSrc, 'systems/dnd5e/tokens/humanoid/Bandit.webp');
  // Falls back to img when a document has no prototype token texture.
  assert.equal(distill({ name: 'X', img: 'a.webp', system: {} }).tokenSrc, 'a.webp');
});

test('srdIndex keys by name, sorts, and skips unnamed documents', () => {
  const idx = srdIndex([LAMIA, BANDIT, { system: {} }]);
  assert.deepEqual(Object.keys(idx), ['Bandit', 'Lamia'], 'sorted, unnamed dropped');
  assert.equal(idx.Lamia.cr, 4);
});

test('parseArgs defaults out to content/reference and rejects junk', () => {
  const o = parseArgs(['--data', '/tmp/fvtt']);
  assert.equal(o.data, '/tmp/fvtt');
  assert.ok(o.out.endsWith(path.join('content', 'reference')));
  assert.equal(o.art, undefined);
  assert.equal(parseArgs(['--art', '/v/tokens']).art, '/v/tokens');
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('copyArt extracts real art and skips core placeholders', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'srd-art-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(path.join(dataDir, 'Data', 'systems', 'dnd5e', 'tokens', 'humanoid'), {
    recursive: true,
  });
  await writeFile(path.join(dataDir, 'Data', 'systems/dnd5e/tokens/humanoid/Bandit.webp'), 'fake');

  const artDir = path.join(dir, 'tokens');
  const copied = await copyArt(
    {
      Bandit: { name: 'Bandit', tokenSrc: 'systems/dnd5e/tokens/humanoid/Bandit.webp' },
      Placeholder: { name: 'Placeholder', tokenSrc: 'icons/svg/mystery-man.svg' },
      Missing: { name: 'Missing', tokenSrc: 'systems/dnd5e/tokens/nope.webp' },
    },
    dataDir,
    artDir,
  );

  assert.equal(copied, 1, 'only the real, present image copies');
  // Named by creature, so a statblock note can reference it by name.
  assert.deepEqual(await readdir(artDir), ['Bandit.webp']);
});

test('both SRD editions are indexed so a note can cite either', () => {
  assert.deepEqual(
    PACKS.map(p => p.edition),
    ['5.1', '5.2'],
  );
  assert.deepEqual(
    PACKS.map(p => p.out),
    ['srd-51.json', 'srd-52.json'],
  );
});

test('assertDataDir names the real cause when the packs are missing', async () => {
  // In the devcontainer this used to surface only as "Skipping monsters:"
  // twice, which reads like a missing dnd5e system rather than an unmounted
  // Foundry data directory.
  await assert.rejects(
    () => assertDataDir('/nonexistent-foundry-data'),
    err => {
      assert.match(err.message, /No dnd5e packs at/);
      assert.match(err.message, /FOUNDRY_DATA_PATH/);
      return true;
    },
  );
});

test('an art-copy failure is reported as such, not as a cache failure', () => {
  // Observed for real: --art "$DND_VAULT_PATH/..." with the variable unset
  // expanded to "/06 Assets/...", mkdir failed with EACCES, and because the
  // copy sat inside the pack's try/catch the run reported "Nothing was
  // written" — immediately after writing both caches.
  const err = new Error("EACCES: permission denied, mkdir '/06 Assets'");
  const msg = explainArtError(err, '/06 Assets/Tokens/srd');
  assert.match(msg, /caches were written successfully/);
  assert.match(msg, /only the token-art copy failed/);
  assert.match(msg, /EACCES/);
});

test('explainArtError recognises the unset-variable path shape', () => {
  // A first path segment containing a space is the tell-tale of
  // "$DND_VAULT_PATH/06 Assets/..." with nothing on the left of the slash.
  assert.match(explainArtError(new Error('x'), '/06 Assets/Tokens/srd'), /DND_VAULT_PATH is unset/);
  // A legitimate absolute path gets no such speculation.
  assert.doesNotMatch(
    explainArtError(new Error('x'), '/home/me/DnD/06 Assets/Tokens/srd'),
    /DND_VAULT_PATH is unset/,
  );
});

test('copyArt surfaces an unwritable target rather than copying nothing quietly', async () => {
  // Per-file copies are intentionally forgiving (missing art is normal), but
  // being unable to create the directory at all is a real error.
  await assert.rejects(
    () =>
      copyArt(
        { X: { name: 'X', tokenSrc: 'systems/dnd5e/tokens/a.webp' } },
        '/data',
        '/06 Assets/x',
      ),
    /EACCES|EROFS|permission denied|read-only/i,
  );
});
