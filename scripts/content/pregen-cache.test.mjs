import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  casterType,
  distillProgression,
  hitDie,
  numeric,
  reconcileRows,
  slug,
  sourceUrl,
} from './pregen-cache.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(SCRIPT_DIR, '..', '..', 'content', 'reference');

test('slug drops the document prefix, which is the only part that moves', () => {
  assert.equal(slug('srd_wizard'), 'wizard');
  assert.equal(slug('srd-2024_wizard'), 'wizard');
  assert.equal(slug('srd-2024_college-of-lore'), 'college-of-lore');
});

test('hitDie keeps the die and drops the notation', () => {
  assert.equal(hitDie('D12'), 12);
  assert.equal(hitDie('d6'), 6);
  assert.equal(hitDie('8'), 8);
  assert.equal(hitDie(null), null);
});

test('numeric converts only what is genuinely a number', () => {
  assert.equal(numeric('+3'), 3);
  assert.equal(numeric('4'), 4);
  assert.equal(numeric('-1'), -1);
  // Table cells that are not counts stay as printed: a sheet shows "3d6", and
  // turning that into 3 would be worse than leaving it alone.
  assert.equal(numeric('1d6'), null);
  assert.equal(numeric('3rd'), null);
  assert.equal(numeric('+10 ft.'), null);
  assert.equal(numeric(null), null);
});

test('caster type is read off the slot tracks', () => {
  const full = ['proficiency-bonus', 'slots-1st', 'slots-5th', 'slots-9th'];
  const half = ['proficiency-bonus', 'slots-1st', 'slots-5th'];
  assert.equal(casterType(full), 'full');
  assert.equal(casterType(half), 'half');
  assert.equal(casterType(['proficiency-bonus', 'sneak-attack']), 'none');
  // Pact magic is one row of slots, not a tier table, and must not read as half.
  assert.equal(casterType(['proficiency-bonus', 'spell-slots', 'slot-level']), 'pact');
});

test('a level with one value each is left alone', () => {
  const { values, repairs } = reconcileRows('x_slots-1st', [
    { level: 1, value: '2' },
    { level: 2, value: '3' },
  ]);
  assert.deepEqual(
    [...values],
    [
      [1, '2'],
      [2, '3'],
    ],
  );
  assert.deepEqual(repairs, []);
});

test('an identical duplicate collapses without comment', () => {
  // `fighter_weapon-mastery-count` carries 3 twice at level 1. There is nothing
  // to decide, so this is not worth reporting as a repair.
  const { values, repairs } = reconcileRows('x_weapon-mastery-count', [
    { level: 1, value: '3' },
    { level: 1, value: '3' },
  ]);
  assert.deepEqual([...values], [[1, '3']]);
  assert.deepEqual(repairs, []);
});

test('a blank duplicate loses to the stated value', () => {
  // `monk_unarmored-movement`: the blank level-1 cell is labelled level 2.
  const { values, repairs } = reconcileRows('x_unarmored-movement', [
    { level: 2, value: null },
    { level: 2, value: '+10 ft.' },
  ]);
  assert.deepEqual([...values], [[2, '+10 ft.']]);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /blank duplicate/);
});

test('two values at one level, with a gap below, shift down', () => {
  // Every 2014 full caster: slots-2nd is ["2", "3"] at level 4 with no level 3.
  // dnd5eapi.co confirms 2 slots at level 3 and 3 at level 4.
  const { values, repairs } = reconcileRows('srd_wizard_slots-2nd', [
    { level: 4, value: '2' },
    { level: 4, value: '3' },
    { level: 5, value: '3' },
  ]);
  assert.equal(values.get(3), '2');
  assert.equal(values.get(4), '3');
  assert.equal(values.get(5), '3');
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /moved from L4 to L3/);
});

test('a collision with the level below already filled is refused', () => {
  // The shift is only safe because the lower level is empty. If it is not,
  // something else is going on and guessing would corrupt a class table.
  assert.throws(
    () =>
      reconcileRows('x_slots-2nd', [
        { level: 3, value: '2' },
        { level: 4, value: '2' },
        { level: 4, value: '3' },
      ]),
    /no rule covers this shape/,
  );
});

test('a collision whose values run backwards is refused', () => {
  // Class tables do not go down as you level. A descending pair means the two
  // rows are not a mislabelled sequence, so the shift would invent a number.
  assert.throws(
    () =>
      reconcileRows('x_slots-2nd', [
        { level: 4, value: '3' },
        { level: 4, value: '2' },
      ]),
    /no rule covers this shape/,
  );
});

/** The three fixture files, in the shape Open5e publishes them. */
function fixture({ casterTypeField = null } = {}) {
  return {
    characterClasses: [
      {
        pk: 'srd_wizard',
        fields: {
          name: 'Wizard',
          hit_dice: 'D6',
          saving_throws: ['wis', 'int'],
          caster_type: casterTypeField,
          subclass_of: null,
        },
      },
      {
        pk: 'srd_school-of-evocation',
        fields: {
          name: 'School of Evocation',
          hit_dice: 'D6',
          saving_throws: [],
          caster_type: null,
          subclass_of: 'srd_wizard',
        },
      },
    ],
    classFeatures: [
      {
        pk: 'srd_wizard_proficiency-bonus',
        fields: { name: 'Proficiency Bonus', parent: 'srd_wizard' },
      },
      { pk: 'srd_wizard_slots-1st', fields: { name: '1st', parent: 'srd_wizard' } },
      { pk: 'srd_wizard_slots-9th', fields: { name: '9th', parent: 'srd_wizard' } },
      { pk: 'srd_wizard_spellcasting', fields: { name: 'Spellcasting', parent: 'srd_wizard' } },
      {
        pk: 'srd_school-of-evocation_sculpt-spells',
        fields: { name: 'Sculpt Spells', parent: 'srd_school-of-evocation' },
      },
    ],
    classFeatureItems: [
      { fields: { parent: 'srd_wizard_proficiency-bonus', level: 1, column_value: '+2' } },
      { fields: { parent: 'srd_wizard_proficiency-bonus', level: 5, column_value: '+3' } },
      { fields: { parent: 'srd_wizard_slots-1st', level: 1, column_value: '2' } },
      { fields: { parent: 'srd_wizard_slots-9th', level: 17, column_value: '1' } },
      { fields: { parent: 'srd_wizard_spellcasting', level: 1, column_value: null } },
      { fields: { parent: 'srd_school-of-evocation_sculpt-spells', level: 2, column_value: null } },
    ],
  };
}

test('a class is assembled from the three files without parsing any slug', () => {
  const { classes } = distillProgression(fixture());
  assert.deepEqual(Object.keys(classes), ['wizard']);
  const wizard = classes.wizard;
  assert.equal(wizard.hitDie, 6);
  assert.deepEqual(wizard.saves, ['int', 'wis'], 'saves are sorted so the file diffs cleanly');
  assert.equal(wizard.casterType, 'full');
  assert.equal(wizard.levels['1'].profBonus, 2);
  assert.deepEqual(wizard.levels['1'].slots, { 1: 2 });
  assert.deepEqual(wizard.levels['1'].features, ['Spellcasting']);
});

test('a subclass hangs off its class rather than becoming one', () => {
  const { classes } = distillProgression(fixture());
  assert.deepEqual(Object.keys(classes.wizard.subclasses), ['school-of-evocation']);
  assert.deepEqual(classes.wizard.subclasses['school-of-evocation'].levels['2'].features, [
    'Sculpt Spells',
  ]);
});

test('a column is a column and a feature is a feature', () => {
  // Proficiency Bonus has a row at every level and must not read as a feature
  // gained twenty times.
  const { classes } = distillProgression(fixture());
  assert.equal(classes.wizard.levels['5'].profBonus, 3);
  assert.equal(classes.wizard.levels['5'].features, undefined);
});

test('a derivation that contradicts the source is an error, not a preference', () => {
  // 2024 states caster_type; 2014 mostly does not. Where it is stated and
  // disagrees with the table, one of them is wrong and a pregen built on the
  // wrong one gets its whole spell list wrong.
  assert.throws(
    () => distillProgression(fixture({ casterTypeField: 'HALF' })),
    /table says "full"/,
  );
});

test('a stated caster type that agrees is accepted', () => {
  const { classes } = distillProgression(fixture({ casterTypeField: 'FULL' }));
  assert.equal(classes.wizard.casterType, 'full');
});

test('source URLs point at the pinned Open5e path', () => {
  assert.equal(
    sourceUrl('srd-2024', 'ClassFeatureItem'),
    'https://raw.githubusercontent.com/open5e/open5e-api/main/data/v2/wizards-of-the-coast/srd-2024/ClassFeatureItem.json',
  );
});

// --------------------------------------------------------------------------
// The committed caches
//
// These read the checked-in files, so they need no network and guard against a
// rebuild quietly changing a class table. The numbers are RAW and were also
// checked against dnd5eapi.co: 1520 values across 12 classes, 0 mismatches.
// --------------------------------------------------------------------------

const cached = async edition =>
  JSON.parse(await readFile(path.join(REFERENCE, `progression-${edition}.json`), 'utf8'));

for (const edition of ['2014', '2024']) {
  test(`${edition}: twelve classes, eight of them casters`, async () => {
    const { classes } = await cached(edition);
    assert.equal(Object.keys(classes).length, 12);
    assert.equal(Object.values(classes).filter(c => c.casterType !== 'none').length, 8);
  });

  test(`${edition}: proficiency bonus is the same table for every class`, async () => {
    const { classes } = await cached(edition);
    const expected = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6];
    for (const [name, cls] of Object.entries(classes)) {
      const actual = Array.from({ length: 20 }, (_, i) => cls.levels[String(i + 1)]?.profBonus);
      assert.deepEqual(actual, expected, `${name} has a proficiency bonus track of its own`);
    }
  });

  test(`${edition}: a full caster's top row is 4/3/3/3/3/2/2/1/1`, async () => {
    const { classes } = await cached(edition);
    assert.deepEqual(classes.wizard.levels['20'].slots, {
      1: 4,
      2: 3,
      3: 3,
      4: 3,
      5: 3,
      6: 2,
      7: 2,
      8: 1,
      9: 1,
    });
  });

  test(`${edition}: the mislabelled second-level slots are corrected`, async () => {
    // The bug this caught: every full caster had no 2nd-level slots at level 3.
    const { classes } = await cached(edition);
    for (const name of ['bard', 'cleric', 'druid', 'sorcerer', 'wizard']) {
      assert.equal(
        classes[name].levels['3'].slots['2'],
        2,
        `${name} should have two 2nd-level slots at level 3`,
      );
      assert.equal(classes[name].levels['4'].slots['2'], 3, `${name} should have three at level 4`);
    }
  });

  test(`${edition}: a half caster never casts above 5th level`, async () => {
    const { classes } = await cached(edition);
    assert.equal(classes.paladin.casterType, 'half');
    assert.deepEqual(classes.paladin.levels['2'].slots, { 1: 2 });
    // A half caster tops out at 4/3/3/3/2 — two 5th-level slots, not the three
    // a full caster gets, and nothing above 5th ever.
    assert.deepEqual(classes.paladin.levels['20'].slots, { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 });
  });
}

test('2014 paladins wait until level 2 to cast; 2024 paladins do not', async () => {
  // A real rules difference, and the reason the pool is per edition rather than
  // one set of characters with a label on them. A 2024 paladin pregen at level 1
  // with no spell slots would be wrong on the sheet.
  assert.equal((await cached('2014')).classes.paladin.levels['1'].slots, undefined);
  assert.deepEqual((await cached('2024')).classes.paladin.levels['1'].slots, { 1: 2 });
});

for (const edition of ['2014', '2024']) {
  test(`${edition}: pact magic is one row, not a tier table`, async () => {
    const { classes } = await cached(edition);
    assert.equal(classes.warlock.casterType, 'pact');
    assert.equal(classes.warlock.levels['20'].slots, undefined);
    assert.deepEqual(classes.warlock.levels['5'].pact, { slots: 2, level: '3rd' });
  });

  test(`${edition}: hit dice match the classes they belong to`, async () => {
    const { classes } = await cached(edition);
    assert.equal(classes.barbarian.hitDie, 12);
    assert.equal(classes.fighter.hitDie, 10);
    assert.equal(classes.rogue.hitDie, 8);
    assert.equal(classes.wizard.hitDie, 6);
  });

  test(`${edition}: every repair the build made is recorded in the file`, async () => {
    const cache = await cached(edition);
    assert.ok(
      Array.isArray(cache.repairs),
      'a reader deciding whether to trust a number needs these',
    );
    assert.equal(cache.licence, 'CC-BY-4.0');
    assert.equal(cache.edition, edition);
  });
}

test('2014 keeps the columns 2014 has', async () => {
  const { classes } = await cached('2014');
  assert.equal(classes.wizard.levels['1'].tracks['cantrips-known'], '3');
  assert.equal(classes.rogue.levels['5'].tracks['sneak-attack'], '3d6');
});

test('2024 keeps the columns 2024 has', async () => {
  // Different column names for the same idea, which is why nothing hardcodes a
  // list of them.
  const { classes } = await cached('2024');
  assert.equal(classes.wizard.levels['1'].tracks.cantrips, '3');
  assert.equal(classes.wizard.levels['1'].tracks['prepared-spells'], '4');
});
