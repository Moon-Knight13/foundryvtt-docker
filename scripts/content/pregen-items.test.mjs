import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { contentFromSheet } from './sheet-content.mjs';
import {
  descriptionHtml,
  featItem,
  gearItem,
  itemsFromContent,
  parseDamage,
  sizeKey,
  tokenScale,
  spellItem,
  splitWeaponNotes,
  traitsFromContent,
  weaponItem,
} from './pregen-items.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const POOL = [
  process.env.DND_VAULT_PATH,
  path.resolve(SCRIPT_DIR, '..', '..', 'DnD'),
  path.join(os.homedir(), 'DnD'),
]
  .filter(Boolean)
  .map(v => path.join(v, '01 Systems', 'dnd5e', 'Pregens'))
  .find(p => existsSync(path.join(p, 'human_fighter_lv1.pdf')));
const skip = POOL ? false : 'vault not mounted';
const sheet = name => readFile(path.join(POOL, `${name}.pdf`));

test('sizeKey maps the printed word to what dnd5e stores', () => {
  assert.equal(sizeKey('Small'), 'sm');
  assert.equal(sizeKey('Medium'), 'med');
  assert.equal(sizeKey('LARGE'), 'lg');
  assert.equal(sizeKey(''), 'med', 'an unread size is medium, not undefined');
});

test('parseDamage splits the formula from the type', () => {
  assert.deepEqual(parseDamage('2d6+2 Slashing'), { formula: '2d6+2', type: 'slashing' });
  assert.deepEqual(parseDamage('3 Bludgeoning'), { formula: '3', type: 'bludgeoning' });
  assert.equal(parseDamage(''), null);
  assert.equal(parseDamage('nonsense here and more'), null);
});

test('attack notes split into three different kinds of fact', () => {
  const { properties, masteries, rest } = splitWeaponNotes([
    'Martial',
    'Heavy',
    'Two-Handed',
    'Graze',
  ]);
  assert.deepEqual(properties, ['hea', 'two']);
  assert.deepEqual(masteries, ['Graze']);
  assert.deepEqual(rest, ['Martial'], 'a category is neither a property nor a mastery');
});

test('a weapon keeps the mastery its owner chose', () => {
  const item = weaponItem({
    name: 'Greatsword',
    attackBonus: '+4',
    damage: '2d6+2 Slashing',
    properties: ['Martial', 'Heavy', 'Two-Handed', 'Graze'],
  });
  assert.equal(item.type, 'weapon');
  assert.equal(item.system.mastery, 'graze');
  assert.equal(item.system.damage.base.custom.formula, '2d6+2');
  assert.equal(item.system.equipped, true, 'it is on the attack table, so it is in hand');
});

test('a weapon the sheet gives no damage for still becomes an item', () => {
  const item = weaponItem({
    name: 'Unarmed Strike',
    attackBonus: '+4',
    damage: null,
    properties: [],
  });
  assert.equal(item.name, 'Unarmed Strike');
  assert.deepEqual(item.system.damage, {}, 'empty rather than an invented default');
});

test('a feat, a class feature and a species trait are filed differently', () => {
  const entry = { name: 'Alert', text: 'Initiative Proficiency.', source: 'PHB-2024', page: 200 };
  assert.equal(featItem(entry, 'feat').system.type.value, 'feat');
  assert.equal(featItem(entry, 'class').system.type.value, 'class');
  assert.equal(featItem(entry, 'race').system.type.value, 'race');
});

test('a feature carries its rules text and its page reference', () => {
  const item = featItem(
    { name: 'Sneak Attack', text: 'Once per turn…', source: 'PHB-2024', page: 129 },
    'class',
  );
  assert.match(item.system.description.value, /Once per turn/);
  assert.match(item.system.description.value, /PHB-2024 p\.129/);
});

test('description HTML escapes what the sheet printed', () => {
  assert.match(descriptionHtml('a < b & c'), /a &lt; b &amp; c/);
  assert.equal(descriptionHtml(''), '');
});

test('gear is loot, because the sheet does not say it is armour', () => {
  const item = gearItem({ name: 'Chain Mail', quantity: 1, weight: '55 lb.' });
  assert.equal(item.type, 'loot');
  assert.equal(item.system.weight.value, 55);
  assert.equal(item.system.quantity, 1);
});

test('a ritual spell is flagged as one', () => {
  assert.deepEqual(spellItem({ name: 'Detect Magic', level: 1, ritual: true }).system.properties, [
    'ritual',
  ]);
  assert.equal(spellItem({ name: 'Bless', level: 1, ritual: false }).system.properties, undefined);
});

test('a cantrip is level 0, not level null', () => {
  assert.equal(spellItem({ name: 'Light', level: 0 }).system.level, 0);
  assert.equal(spellItem({ name: 'Mystery', level: null }).system.level, 0);
});

test('no content means no items, rather than a crash', () => {
  assert.deepEqual(itemsFromContent(null), []);
  assert.deepEqual(traitsFromContent(null), {});
});

// --------------------------------------------------------------------------
// Against the real exports.
// --------------------------------------------------------------------------

test('a fighter arrives carrying what its sheet lists', { skip }, async () => {
  const content = contentFromSheet(await sheet('human_fighter_lv1'));
  const items = itemsFromContent(content, { species: 'Human', background: 'Soldier' });
  const types = items.reduce((acc, i) => ({ ...acc, [i.type]: (acc[i.type] ?? 0) + 1 }), {});

  assert.equal(types.race, 1);
  assert.equal(types.background, 1);
  assert.equal(types.weapon, 3);
  assert.equal(types.loot, 4);
  assert.ok(types.feat >= 10, 'class features, species traits and feats all become items');
  assert.ok(items.some(i => i.name === 'Chain Mail'));
  assert.ok(items.some(i => i.name === 'Lucky' && i.system.type.value === 'feat'));
});

test('a cleric arrives with its spells at the right levels', { skip }, async () => {
  const content = contentFromSheet(await sheet('dwarf_cleric_lv1'));
  const items = itemsFromContent(content, { species: 'Dwarf', background: 'Acolyte' });
  const spells = items.filter(i => i.type === 'spell');

  assert.equal(spells.length, 19);
  assert.equal(spells.filter(s => s.system.level === 0).length, 4);
  assert.equal(spells.find(s => s.name === 'Sacred Flame').system.level, 0);
  assert.equal(spells.find(s => s.name === 'Bless').system.level, 1);
});

test('a small character is small, since nothing will derive it later', { skip }, async () => {
  // Packed documents skip dnd5e's _preCreate. Whatever this writes is final.
  const traits = traitsFromContent(contentFromSheet(await sheet('halfling_rogue_lv1')));
  assert.equal(traits.size, 'sm');
});

test('proficiencies and languages reach the actor', { skip }, async () => {
  const traits = traitsFromContent(contentFromSheet(await sheet('halfling_rogue_lv1')));

  assert.equal(traits.armorProf.custom, 'Light Armor');
  assert.match(traits.toolProf.custom, /Thieves' Tools/);
  assert.match(traits.languages.custom, /Halfling/);
});

test('every pool character produces a materially furnished actor', { skip }, async () => {
  for (const name of [
    'dwarf_cleric_lv1',
    'elf_wizard_lv1',
    'goliath_barbarian_lv1',
    'halfling_rogue_lv1',
    'human_fighter_lv1',
  ]) {
    const content = contentFromSheet(await sheet(name));
    const items = itemsFromContent(content, { species: 'X', background: 'Y' });
    assert.ok(items.length >= 20, `${name} produced only ${items.length} items`);
    assert.ok(
      items.every(i => i.name && i.type),
      `${name} produced a nameless or typeless item`,
    );
  }
});

test('a Small token is drawn smaller inside the one square it occupies', () => {
  // The footprint and the scale are different facts: a Small creature takes one
  // square like a Medium one, and is drawn at 80% inside it. Both come from
  // ddb-importer's size table, which dnd5e's own importer works from.
  assert.equal(tokenScale('sm'), 0.8);
  assert.equal(tokenScale('med'), 1);
  assert.equal(tokenScale('lg'), 1);
  assert.equal(tokenScale(undefined), 1);
});
