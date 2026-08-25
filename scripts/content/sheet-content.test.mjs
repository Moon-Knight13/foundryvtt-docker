import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { commaList, contentFromSheet, parseEntries, splitSections } from './sheet-content.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const POOL = [
  process.env.DND_VAULT_PATH,
  path.resolve(SCRIPT_DIR, '..', '..', 'DnD'),
  path.join(os.homedir(), 'DnD'),
]
  .filter(Boolean)
  .map(v => path.join(v, '01 Systems', 'dnd5e', 'Pregens'))
  .find(p => existsSync(path.join(p, 'human_fighter', 'human_fighter_lv1.pdf')));
const skip = POOL ? false : 'vault not mounted';

// A pool sheet lives in a folder named after its character:
//   Pregens/human_fighter/human_fighter_lv1.pdf
const sheet = name => readFile(path.join(POOL, name.replace(/_lv\d+$/, ''), `${name}.pdf`));

// --------------------------------------------------------------------------
// The prose grammar, on its own.
// --------------------------------------------------------------------------

test('=== headings === open sections, in the order a reader sees them', () => {
  const sections = splitSections('=== ARMOR ===\nLight Armor\n\n=== TOOLS ===\nThieves Tools');
  assert.deepEqual(
    sections.map(s => s.heading),
    ['ARMOR', 'TOOLS'],
  );
  assert.equal(sections[0].text, 'Light Armor');
});

test('text before the first heading belongs to no section', () => {
  assert.deepEqual(splitSections('loose words\n=== A ===\nx'), [{ heading: 'A', text: 'x' }]);
});

test('a * line opens an entry and names its source page', () => {
  const [entry] = parseEntries('* Sneak Attack • PHB-2024 129\nOnce per turn…');
  assert.equal(entry.name, 'Sneak Attack');
  assert.equal(entry.source, 'PHB-2024');
  assert.equal(entry.page, 129);
  assert.equal(entry.text, 'Once per turn…');
});

test('an entry with no page reference still parses', () => {
  const [entry] = parseEntries('* Weapon Mastery • PHB-2024 \nmastery');
  assert.equal(entry.name, 'Weapon Mastery');
  assert.equal(entry.page, null);
});

test("prose runs until the next entry, so one feature's text is not another's", () => {
  const entries = parseEntries('* A • PHB-2024 1\nfirst\n* B • PHB-2024 2\nsecond');
  assert.equal(entries[0].text, 'first');
  assert.equal(entries[1].text, 'second');
});

test('commaList trims and drops the empties', () => {
  assert.deepEqual(commaList(' a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(commaList(''), []);
  assert.deepEqual(commaList(null), []);
});

// --------------------------------------------------------------------------
// Against the real exports. These assert what is on a sheet somebody built,
// which is the only thing that can grade a reader.
// --------------------------------------------------------------------------

test('a fighter carries its armour, bow and lantern', { skip }, async () => {
  const { equipment } = contentFromSheet(await sheet('human_fighter_lv1'));
  assert.deepEqual(
    equipment.map(e => e.name),
    ['Chain Mail', 'Shortbow', 'Greatsword', 'Hooded Lantern'],
  );
  assert.equal(equipment[0].weight, '55 lb.');
  assert.equal(equipment[0].quantity, 1);
});

test('a weapon carries the mastery property its owner chose', { skip }, async () => {
  const { weapons } = contentFromSheet(await sheet('human_fighter_lv1'));
  const greatsword = weapons.find(w => w.name === 'Greatsword');

  assert.equal(greatsword.attackBonus, '+4');
  assert.equal(greatsword.damage, '2d6+2 Slashing');
  assert.ok(greatsword.properties.includes('Graze'), 'the 2024 mastery choice is here or nowhere');
});

test('the first attack row reads, despite carrying no row number', { skip }, async () => {
  // `Wpn Name`, then `Wpn Name 2`. Retyping either is how a row goes missing.
  const { weapons } = contentFromSheet(await sheet('halfling_rogue_lv1'));
  assert.equal(weapons.length, 4);
  assert.equal(weapons[0].name, 'Dagger');
});

test('spells land at the level of the heading above them', { skip }, async () => {
  const { spells } = contentFromSheet(await sheet('dwarf_cleric_lv1'));
  const cantrips = spells.filter(s => s.level === 0).map(s => s.name);

  assert.deepEqual(cantrips, ['Light', 'Sacred Flame', 'Thaumaturgy', 'Toll the Dead']);
  assert.equal(spells.filter(s => s.level === 1).length, 15);
});

test('a ritual is flagged, and its name does not keep the marker', { skip }, async () => {
  const { spells } = contentFromSheet(await sheet('dwarf_cleric_lv1'));
  const detect = spells.find(s => s.name === 'Detect Magic');

  assert.ok(detect, 'the [R] marker must not end up part of the name');
  assert.equal(detect.ritual, true);
  assert.equal(spells.find(s => s.name === 'Bless').ritual, false);
});

test('a spell records where it came from, which is not always the class', { skip }, async () => {
  const { spells } = contentFromSheet(await sheet('dwarf_cleric_lv1'));
  assert.equal(spells.find(s => s.name === 'Toll the Dead').source, 'Divine Order');
});

test('a non-caster has no spells rather than an empty group', { skip }, async () => {
  const { spells } = contentFromSheet(await sheet('goliath_barbarian_lv1'));
  assert.deepEqual(spells, []);
});

test('proficiencies split into the four the sheet keeps', { skip }, async () => {
  const { proficiencies } = contentFromSheet(await sheet('halfling_rogue_lv1'));

  assert.deepEqual(proficiencies.armor, ['Light Armor']);
  assert.deepEqual(proficiencies.tools, ['Disguise Kit', "Thieves' Tools"]);
  assert.ok(proficiencies.languages.includes('Halfling'));
  assert.ok(proficiencies.weapons.includes('Rapier'));
});

test('a heading the sheet omits is an empty list, not a missing key', { skip }, async () => {
  // The wizard is proficient with no armour at all. That is a fact, not a gap.
  const { proficiencies } = contentFromSheet(await sheet('elf_wizard_lv1'));
  assert.deepEqual(proficiencies.armor, []);
});

test('features, species traits and feats are kept apart', { skip }, async () => {
  const { features } = contentFromSheet(await sheet('halfling_rogue_lv1'));

  assert.ok(features.class.some(f => f.name === 'Sneak Attack'));
  assert.ok(features.species.some(f => f.name === 'Naturally Stealthy'));
  assert.ok(features.feats.some(f => f.name === 'Alert'));
  assert.ok(!features.class.some(f => f.name === 'Alert'), 'a feat is not a class feature');
});

test('a feature keeps its rules text and its page reference', { skip }, async () => {
  const { features } = contentFromSheet(await sheet('halfling_rogue_lv1'));
  const sneak = features.class.find(f => f.name === 'Sneak Attack');

  assert.equal(sneak.source, 'PHB-2024');
  assert.equal(sneak.page, 129);
  assert.match(sneak.text, /extra 1d6 damage/);
});

test('size is read, because dnd5e will not derive it for packed content', { skip }, async () => {
  assert.equal(contentFromSheet(await sheet('halfling_rogue_lv1')).size, 'Small');
  assert.equal(contentFromSheet(await sheet('human_fighter_lv1')).size, 'Medium');
});

test('coins are counted', { skip }, async () => {
  const { coins } = contentFromSheet(await sheet('human_fighter_lv1'));
  assert.equal(coins.gp, 5);
  assert.equal(coins.cp, 0);
});

test(
  'every pool sheet yields content, not just the one it was written against',
  {
    skip,
  },
  async () => {
    for (const name of [
      'dwarf_cleric_lv1',
      'elf_wizard_lv1',
      'goliath_barbarian_lv1',
      'halfling_rogue_lv1',
      'human_fighter_lv1',
    ]) {
      const content = contentFromSheet(await sheet(name));
      assert.ok(content.weapons.length, `${name} has no attack rows`);
      assert.ok(content.features.class.length, `${name} has no class features`);
      assert.ok(content.features.species.length, `${name} has no species traits`);
      assert.ok(content.proficiencies.languages.length, `${name} has no languages`);
      assert.ok(content.size, `${name} has no size`);
    }
  },
);
