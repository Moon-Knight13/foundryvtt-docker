import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distill, open5eIndex, parseArgs, creatureUrl, EDITIONS } from './open5e-cache.mjs';

// Trimmed from the real SRD 5.1 Lamia record as the open5e-api fixtures ship
// it. Note challenge_rating is the STRING "4.000", size is spelled out, and the
// skill bonuses are stated totals rather than proficiency multipliers.
const LAMIA_2014 = {
  name: 'Lamia',
  armor_class: 13,
  armor_detail: 'natural armor',
  hit_points: 97,
  hit_dice: '13d10 + 26',
  challenge_rating: '4.000',
  size: 'large',
  type: 'monstrosity',
  walk: 30,
  fly: null,
  swim: null,
  ability_score_strength: 16,
  ability_score_dexterity: 13,
  ability_score_constitution: 15,
  ability_score_intelligence: 14,
  ability_score_wisdom: 15,
  ability_score_charisma: 16,
  saving_throw_wisdom: 2,
  saving_throw_strength: null,
  skill_bonus_deception: 7,
  skill_bonus_insight: 4,
  skill_bonus_stealth: 3,
  skill_bonus_arcana: null,
  darkvision_range: 60,
  blindsight_range: null,
  languages_desc: 'Abyssal, Common',
};

// The armour-wearing case: the dnd5e compendium stores {calc:"default",
// flat:null} for this creature, so its AC of 12 was not checkable at all
// before. Open5e states it outright, which is the reason this source exists.
const BANDIT = {
  name: 'Bandit',
  armor_class: 12,
  armor_detail: 'leather armor',
  hit_points: 11,
  challenge_rating: '0.125',
  size: 'medium',
  type: 'humanoid',
  walk: 30,
  ability_score_strength: 11,
  ability_score_dexterity: 12,
  ability_score_constitution: 12,
  ability_score_intelligence: 10,
  ability_score_wisdom: 10,
  ability_score_charisma: 10,
  languages_desc: 'any one language (usually Common)',
};

test('distill reads the stated stats, normalising Open5e quirks', () => {
  const d = distill(LAMIA_2014);
  assert.equal(d.name, 'Lamia');
  assert.equal(d.hp, 97);
  assert.equal(d.hpFormula, '13d10 + 26');
  // challenge_rating arrives as the string "4.000".
  assert.equal(d.cr, 4);
  assert.equal(d.type, 'monstrosity');
  assert.deepEqual(d.abilities, { str: 16, dex: 13, con: 15, int: 14, wis: 15, cha: 16 });
  assert.equal(d.languages, 'Abyssal, Common');
});

test('distill gives a numeric AC even for armour wearers', () => {
  // The whole point: the dnd5e compendium derives this at runtime and stores
  // null, so Bandit's AC could not be verified from that source at all.
  assert.equal(distill(BANDIT).ac, 12);
  assert.equal(distill(BANDIT).acDetail, 'leather armor');
  assert.equal(distill(LAMIA_2014).ac, 13);
});

test('distill converts sizes to the dnd5e abbreviations verify() compares', () => {
  // Comparing 'large' against 'lg' would flag every creature in the index.
  assert.equal(distill(LAMIA_2014).size, 'lg');
  assert.equal(distill(BANDIT).size, 'med');
  assert.equal(distill({ ...BANDIT, size: 'gargantuan' }).size, 'grg');
});

test('distill keeps skill bonuses as stated totals, keyed like dnd5e', () => {
  const { skills } = distill(LAMIA_2014);
  // Stated bonuses, directly comparable with a fence's `skillsaves`.
  assert.deepEqual(skills, { dec: 7, ins: 4, ste: 3 });
  // Null bonuses are absent, not zero — a creature is not "Arcana +0".
  assert.ok(!('arc' in skills));
  // A creature with no listed skills gets no skills key at all.
  assert.ok(!('skills' in distill(BANDIT)));
});

test('distill drops null saves, speeds and senses', () => {
  const d = distill(LAMIA_2014);
  assert.deepEqual(d.saves, { wis: 2 }, 'null saves must not become 0');
  assert.deepEqual(d.speed, { walk: 30 }, 'null fly/swim must not be recorded');
  assert.deepEqual(d.senses, { darkvision: 60 });
});

test('open5eIndex keys by name, sorts, and accepts the fixture wrapper', () => {
  // The fixtures are Django dumps: {model, pk, fields}.
  const idx = open5eIndex([{ fields: LAMIA_2014 }, { fields: BANDIT }, { fields: {} }]);
  assert.deepEqual(Object.keys(idx), ['Bandit', 'Lamia'], 'sorted, unnamed dropped');
  assert.equal(idx.Lamia.cr, 4);
  // Bare field objects work too.
  assert.equal(open5eIndex([BANDIT]).Bandit.ac, 12);
});

test('both editions are published, and the URL points at the GitHub fixtures', () => {
  assert.deepEqual(
    EDITIONS.map(e => e.key),
    ['2014', '2024'],
  );
  assert.deepEqual(
    EDITIONS.map(e => e.srd),
    ['5.1', '5.2'],
  );
  // GitHub, not api.open5e.com — already reachable, so no firewall change.
  assert.match(creatureUrl('srd-2024'), /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(creatureUrl('srd-2024'), /srd-2024\/Creature\.json$/);
});

test('parseArgs defaults to content/reference and rejects a bad edition', () => {
  assert.ok(parseArgs([]).out.endsWith('reference'));
  assert.equal(parseArgs(['--edition', '2024']).edition, '2024');
  assert.throws(() => parseArgs(['--edition', '2019']), /Unknown edition/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('fetchCreatures reports a bad response instead of returning junk', async () => {
  const { fetchCreatures } = await import('./open5e-cache.mjs');
  await assert.rejects(
    () => fetchCreatures('srd-2024', async () => ({ ok: false, status: 404 })),
    /returned 404/,
  );
});
