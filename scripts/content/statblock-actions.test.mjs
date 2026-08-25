import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attackActivity,
  attackItem,
  featureItem,
  itemsFromStatblock,
  parseAttack,
} from './statblock-actions.mjs';

// --------------------------------------------------------------------------
// Reading the prose. Every string here is verbatim from an SRD statblock in
// the vault, because a parser graded against invented text proves nothing.
// --------------------------------------------------------------------------

test('a 2014 melee attack yields its bonus, reach and damage', () => {
  const a = parseAttack(
    'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 14 (2d10 + 3) slashing damage.',
  );
  assert.equal(a.kind, 'melee');
  assert.equal(a.classification, 'weapon');
  assert.equal(a.bonus, '5');
  assert.equal(a.reach, 5);
  assert.deepEqual(a.damage, {
    number: 2,
    denomination: 10,
    bonus: '3',
    types: ['slashing'],
  });
});

test('the 2024 phrasing parses too, so new statblocks are not left behind', () => {
  const a = parseAttack('Melee Attack Roll: +5, reach 5 ft. Hit: 14 (2d10 + 3) Slashing damage.');
  assert.equal(a.bonus, '5');
  assert.equal(a.reach, 5);
  assert.deepEqual(a.damage.types, ['slashing'], 'the printed type is capitalised in 2024');
});

test('a ranged attack keeps both bands of its range', () => {
  const a = parseAttack(
    'Ranged Weapon Attack: +3 to hit, range 80/320 ft., one target. Hit: 5 (1d8 + 1) piercing damage.',
  );
  assert.equal(a.kind, 'ranged');
  assert.deepEqual(a.range, { value: 80, long: 320 });
});

test('melee or ranged is both, and carries reach and range', () => {
  const a = parseAttack(
    'Melee or Ranged Weapon Attack: +5 to hit, reach 5 ft. or range 20/60 ft., one target. ' +
      'Hit: 5 (1d4 + 3) piercing damage.',
  );
  assert.equal(a.kind, 'both');
  assert.equal(a.reach, 5);
  assert.deepEqual(a.range, { value: 20, long: 60 });
});

test('a spell attack is classified as one', () => {
  const a = parseAttack(
    'Melee Spell Attack: +5 to hit, reach 5 ft., one creature. Hit: The target is cursed.',
  );
  assert.equal(a.classification, 'spell');
  assert.equal(a.damage, null, 'a curse is not damage, and inventing some would be worse');
});

test('flat damage with no dice still parses', () => {
  const a = parseAttack(
    'Melee Weapon Attack: +2 to hit, reach 5 ft., one creature. Hit: 1 piercing damage, and the ' +
      'target must make a DC 9 Constitution saving throw.',
  );
  assert.deepEqual(a.damage.custom, { enabled: true, formula: '1' });
  assert.deepEqual(a.damage.types, ['piercing']);
});

test('prose that is not an attack is refused rather than half-read', () => {
  assert.equal(
    parseAttack('Selyse makes two attacks: one with her claws and one with her dagger.'),
    null,
  );
  assert.equal(parseAttack('The scorpion makes three attacks: two with its claws.'), null);
  assert.equal(parseAttack(''), null);
  assert.equal(parseAttack(undefined), null);
});

test('a damage type dnd5e does not know is dropped, not invented', () => {
  const a = parseAttack(
    'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 6 (1d8 + 2) sparkly damage.',
  );
  assert.deepEqual(a.damage.types, []);
  assert.equal(a.damage.number, 1, 'the dice still read');
});

// --------------------------------------------------------------------------
// The documents. Shapes are copied from dnd5e's own SRD pack sources, because
// a packed Item never has an activity generated for it.
// --------------------------------------------------------------------------

test('an attack carries an activity, or it cannot be rolled', () => {
  const item = attackItem(
    'Claws',
    parseAttack(
      'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 14 (2d10 + 3) slashing damage.',
    ),
    'prose',
  );

  const activities = Object.values(item.system.activities);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].type, 'attack');
  assert.equal(item.type, 'weapon');
  assert.equal(item.system.equipped, true);
});

test("the statblock's printed bonus is used as-is, not derived", () => {
  // Deriving from abilities and proficiency would print a different number
  // from the card the GM is reading.
  const activity = attackActivity(
    'Claws',
    parseAttack(
      'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 14 (2d10 + 3) slashing damage.',
    ),
  );
  assert.equal(activity.attack.flat, true);
  assert.equal(activity.attack.bonus, '5');
});

test('the activity key matches the activity id', () => {
  // dnd5e keys activities by their own id; a mismatch makes it unreachable.
  const item = attackItem(
    'Bite',
    parseAttack(
      'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 6 (1d8 + 2) piercing damage.',
    ),
    '',
  );
  for (const [key, activity] of Object.entries(item.system.activities)) {
    assert.equal(key, activity._id);
  }
});

test('ids are deterministic, so a rebuild does not churn the pack', () => {
  const parsed = parseAttack(
    'Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 6 (1d8 + 2) piercing damage.',
  );
  assert.equal(attackItem('Bite', parsed, '')._id, attackItem('Bite', parsed, '')._id);
});

test('a feature keeps its prose and is typed as a monster feature', () => {
  const item = featureItem('Multiattack', 'Selyse makes two attacks.', { activation: 'action' });
  assert.equal(item.type, 'feat');
  assert.equal(item.system.type.value, 'monster');
  assert.match(item.system.description.value, /two attacks/);
  assert.equal(item.system.activation.type, 'action');
});

test('description HTML is escaped', () => {
  assert.match(featureItem('X', 'a < b & c').system.description.value, /a &lt; b &amp; c/);
});

// --------------------------------------------------------------------------
// A whole statblock.
// --------------------------------------------------------------------------

const SELYSE = {
  traits: [{ name: 'Innate Spellcasting', desc: 'DC 13.' }],
  actions: [
    { name: 'Multiattack', desc: 'Selyse makes two attacks.' },
    {
      name: 'Claws',
      desc: 'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 14 (2d10 + 3) slashing damage.',
    },
    {
      name: 'Dagger',
      desc: 'Melee or Ranged Weapon Attack: +5 to hit, reach 5 ft. or range 20/60 ft., one target. Hit: 5 (1d4 + 3) piercing damage.',
    },
  ],
  reactions: [{ name: 'Parry', desc: 'Adds 2 to its AC.' }],
};

test('a statblock yields a weapon per attack and a feature per everything else', () => {
  const items = itemsFromStatblock(SELYSE);
  const byType = items.reduce((acc, i) => ({ ...acc, [i.type]: (acc[i.type] ?? 0) + 1 }), {});

  assert.deepEqual(byType, { feat: 3, weapon: 2 });
  assert.ok(items.find(i => i.name === 'Claws').type === 'weapon');
  assert.ok(items.find(i => i.name === 'Multiattack').type === 'feat');
});

test('nothing is dropped — an unrollable action is still the first thing read', () => {
  const items = itemsFromStatblock(SELYSE);
  const names = items.map(i => i.name);

  assert.ok(names.includes('Innate Spellcasting'));
  assert.ok(names.includes('Multiattack'));
  assert.ok(names.includes('Parry'));
});

test('a reaction is activated as one', () => {
  const parry = itemsFromStatblock(SELYSE).find(i => i.name === 'Parry');
  assert.equal(parry.system.activation.type, 'reaction');
});

test('a statblock with no actions yields no items rather than throwing', () => {
  assert.deepEqual(itemsFromStatblock({}), []);
});
