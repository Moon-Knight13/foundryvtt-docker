import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToSheet, derive, parseFence } from './pregen.mjs';
import { fieldReader, noteName, poolNote, specFromSheet } from './pool-from-sheets.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(SCRIPT_DIR, '..', '..', 'content', 'reference');

const progression = async edition =>
  JSON.parse(await readFile(path.join(REFERENCE, `progression-${edition}.json`), 'utf8'));

test('a field lookup tolerates stray whitespace, but only when unambiguous', () => {
  // `Stealth ` on the export carries a trailing space its own tick box does not.
  const at = fieldReader({ 'Stealth ': '+7', StealthProf: 'E', AC: '14' });
  assert.equal(at('Stealth'), '+7', 'trimmed match when exactly one field fits');
  assert.equal(at('AC'), '14');
  assert.equal(at('Nonexistent'), null);
});

test('an ambiguous trimmed match is refused rather than guessed', () => {
  // Picking the wrong box quietly is worse than reading nothing: the value
  // would stop being checked without anybody noticing.
  const at = fieldReader({ 'Speed ': '25', ' Speed': '30' });
  assert.equal(at('Speed'), null);
});

test('the note carries the choices and none of the derived numbers', () => {
  // A pool note that repeated the derived numbers would be a second copy to
  // keep in step — exactly what compiling exists to avoid.
  const spec = {
    name: 'Elf Wizard',
    edition: '2014',
    class: 'wizard',
    level: 1,
    species: 'High Elf',
    background: 'Sage',
    abilities: { str: 10, dex: 15, con: 14, int: 16, wis: 12, cha: 8 },
    skills: ['arcana', 'investigation'],
    ac: 12,
    speed: 30,
    hp: 8,
  };
  const note = poolNote(spec, { source: 'Elf_Wizard.pdf' });
  const fence = parseFence(note);
  assert.equal(fence.name, 'Elf Wizard');
  assert.equal(fence.class, 'wizard');
  assert.equal(fence.edition, '2014');
  assert.deepEqual(fence.abilities, spec.abilities);
  assert.deepEqual(fence.skills, ['arcana', 'investigation']);
  // Derived values must not appear as authored ones.
  assert.equal(fence.profBonus, undefined);
  assert.equal(fence.saves, undefined);
  assert.equal(fence.spellSaveDc, undefined);
});

test('a pool note says it belongs to nobody, and carries no player name', () => {
  const note = poolNote(
    {
      name: 'Elf Wizard',
      edition: '2014',
      class: 'wizard',
      level: 1,
      species: 'High Elf',
      background: 'Sage',
      abilities: { str: 10, dex: 15, con: 14, int: 16, wis: 12, cha: 8 },
      skills: [],
      ac: 12,
      hp: 8,
    },
    { source: 'Elf_Wizard.pdf' },
  );
  assert.ok(!/Moon_Knight/i.test(note), 'the exporting account must not travel');
  assert.match(note, /belongs to nobody/);
  // And nothing about any particular game — that is the pool's whole property.
  assert.match(note, /nothing\nabout any particular game/);
});

test('expertise survives into the note', () => {
  const note = poolNote({
    name: 'Halfling Rogue',
    edition: '2014',
    class: 'rogue',
    level: 1,
    species: 'Lightfoot Halfling',
    background: 'Criminal',
    abilities: { str: 8, dex: 16, con: 12, int: 13, wis: 10, cha: 16 },
    skills: ['stealth', 'acrobatics'],
    expertise: ['stealth'],
    ac: 14,
    hp: 9,
  });
  assert.deepEqual(parseFence(note).expertise, ['stealth']);
});

test('the filename is the character name, so a party list reads naturally', () => {
  assert.equal(noteName({ name: 'Elf Wizard' }), 'Elf Wizard.md');
});

// --------------------------------------------------------------------------
// Against the real exports
// --------------------------------------------------------------------------

const VAULT =
  process.env.DND_VAULT_PATH ||
  [path.resolve(SCRIPT_DIR, '..', '..', 'DnD'), path.join(os.homedir(), 'DnD')].find(p =>
    existsSync(p),
  ) ||
  null;
const PREGEN_DIR =
  VAULT && path.join(VAULT, '02 Campaigns', 'Dragons of Stormwreck Isle', 'Pregens');
const SHEETS = ['Dwarf_Cleric', 'Elf_Fighter', 'Elf_Wizard', 'Halfling_Rogue', 'Human_Paladin'];
const skip =
  PREGEN_DIR && SHEETS.every(s => existsSync(path.join(PREGEN_DIR, `${s}.pdf`)))
    ? false
    : 'vault not mounted';

for (const sheet of SHEETS) {
  test(`${sheet} reads into a spec whose numbers match the sheet`, { skip }, async () => {
    // The extraction is only worth anything if what it produces agrees with
    // what it read. A pool pregen that disagrees with its own source is worse
    // than not having it, so this is the check that gates writing the note.
    const bytes = readFileSync(path.join(PREGEN_DIR, `${sheet}.pdf`));
    const { spec, printed } = specFromSheet(bytes);
    const character = derive(spec, await progression('2014'));
    const deltas = compareToSheet(character, printed);
    assert.deepEqual(
      deltas,
      [],
      deltas.map(d => `${d.field}: derived ${d.derived}, sheet ${d.sheet}`).join('\n'),
    );
  });
}

test('the rogue keeps its expertise, not merely proficiency', { skip }, async () => {
  // The bug this guards: the export marks expertise `E`, and reading that as a
  // plain `P` prints +5 where the played sheet says +7.
  const { spec } = specFromSheet(readFileSync(path.join(PREGEN_DIR, 'Halfling_Rogue.pdf')));
  assert.deepEqual(spec.expertise, ['stealth']);
  const character = derive(spec, await progression('2014'));
  assert.equal(character.skills.stealth.total, 7);
});

test('no extracted spec carries the exporting account name', { skip }, () => {
  for (const sheet of SHEETS) {
    const { spec } = specFromSheet(readFileSync(path.join(PREGEN_DIR, `${sheet}.pdf`)));
    assert.ok(!JSON.stringify(spec).includes('Moon_Knight'), `${sheet} leaked a player name`);
  }
});
