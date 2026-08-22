import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fieldMap } from './sheet-fields.mjs';
import {
  classProgress,
  compareToSheet,
  derive,
  deriveHitPoints,
  parseFence,
  signed,
  skillKey,
} from './pregen.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(SCRIPT_DIR, '..', '..', 'content', 'reference');

const progression = async edition =>
  JSON.parse(await readFile(path.join(REFERENCE, `progression-${edition}.json`), 'utf8'));

test('skill names are accepted however they are written', () => {
  assert.equal(skillKey('Animal Handling'), 'animal_handling');
  assert.equal(skillKey('animal-handling'), 'animal_handling');
  assert.equal(skillKey('ani'), 'animal_handling');
  assert.equal(skillKey('Sleight of Hand'), 'sleight_of_hand');
  assert.equal(skillKey('nonsense'), null);
});

test('a sheet prints a sign, so the derivation does too', () => {
  assert.equal(signed(3), '+3');
  assert.equal(signed(0), '+0');
  assert.equal(signed(-1), '-1');
});

test('hit points take the fixed average, not a roll', () => {
  // A rebuild has to produce the same character. Rolling would make every
  // rebuild a different one, which defeats the whole rebuild-survival claim.
  assert.equal(deriveHitPoints(6, 2, 1), 8, 'level 1 is the full die plus CON');
  assert.equal(deriveHitPoints(6, 2, 2), 14, 'then 4 + 2 per level for a d6');
  assert.equal(deriveHitPoints(10, 1, 5), 39, '11 at first, then four levels of 6 + 1');
  // Hill dwarf toughness is +1 per level, including the first.
  assert.equal(deriveHitPoints(8, 2, 3, 1), 27);
});

test('features accumulate up the levels', async () => {
  // A level-5 fighter still has what it gained at level 1; the sheet lists all
  // of it, not just the newest line.
  const progress = classProgress(await progression('2014'), 'fighter', 5);
  assert.ok(progress.features.includes('Second Wind'), 'gained at 1');
  assert.ok(progress.features.includes('Action Surge'), 'gained at 2');
  assert.ok(progress.features.includes('Extra Attack'), 'gained at 5');
  assert.equal(progress.profBonus, 3);
  assert.equal(progress.hitDie, 10);
});

test('a subclass adds its own features and nothing else', async () => {
  const plain = classProgress(await progression('2014'), 'wizard', 5);
  const evoker = classProgress(await progression('2014'), 'wizard', 5, 'school-of-evocation');
  assert.ok(!plain.features.includes('Sculpt Spells'));
  assert.ok(evoker.features.includes('Sculpt Spells'));
  assert.equal(evoker.subclassName, 'School of Evocation');
});

test('an unknown class or subclass says what it does know', async () => {
  const tables = await progression('2024');
  assert.throws(() => classProgress(tables, 'artificer', 3), /Unknown class "artificer"/);
  assert.throws(() => classProgress(tables, 'wizard', 3, 'necromancer'), /Known: evoker/);
});

test('a level outside the tables is refused rather than extrapolated', async () => {
  const tables = await progression('2024');
  assert.throws(() => classProgress(tables, 'wizard', 21), /cover 1 to 20/);
  assert.throws(() => classProgress(tables, 'wizard', 0), /cover 1 to 20/);
});

/** A minimal authored spec — the choices, and only the choices. */
const SPEC = {
  name: 'Test Cleric',
  edition: '2014',
  class: 'cleric',
  level: 1,
  species: 'Hill Dwarf',
  background: 'Soldier',
  abilities: { str: 14, dex: 8, con: 15, int: 10, wis: 16, cha: 12 },
  skills: ['Athletics', 'Intimidation', 'Medicine', 'Religion'],
  ac: 18,
  speed: 25,
};

test('saves come from the class, not from the author', async () => {
  const character = derive(SPEC, await progression('2014'));
  // A cleric is proficient in WIS and CHA saves and nothing else.
  assert.equal(character.saves.wis.proficient, true);
  assert.equal(character.saves.cha.proficient, true);
  assert.equal(character.saves.str.proficient, false);
  assert.equal(character.saves.wis.total, 5, 'WIS 16 is +3, plus proficiency 2');
  assert.equal(character.saves.str.total, 2, 'STR 14 is +2, unproficient');
});

test('skill totals are the modifier plus the proficiency the author chose', async () => {
  const character = derive(SPEC, await progression('2014'));
  assert.equal(character.skills.athletics.total, 4, 'STR +2, proficient');
  assert.equal(character.skills.medicine.total, 5, 'WIS +3, proficient');
  assert.equal(character.skills.acrobatics.total, -1, 'DEX -1, unproficient');
  assert.equal(character.skills.perception.total, 3, 'WIS +3, unproficient');
});

test('expertise doubles proficiency, and cannot exist without it', async () => {
  const tables = await progression('2014');
  const rogue = {
    ...SPEC,
    class: 'rogue',
    skills: ['Stealth'],
    expertise: ['Stealth'],
    abilities: { ...SPEC.abilities, dex: 16 },
  };
  assert.equal(derive(rogue, tables).skills.stealth.total, 7, 'DEX +3 plus twice a +2 bonus');
  assert.throws(
    () => derive({ ...rogue, expertise: ['Acrobatics'] }, tables),
    /expertise in "Acrobatics" without proficiency/,
  );
});

test('spell save DC and attack bonus come out of the same calculation', async () => {
  const character = derive(SPEC, await progression('2014'));
  assert.equal(character.spellcasting.ability, 'wis');
  assert.equal(character.spellcasting.saveDc, 13, '8 + 2 proficiency + 3 WIS');
  assert.equal(character.spellcasting.attackBonus, 5);
  assert.deepEqual(character.spellcasting.slots, { 1: 2 });
});

test('a non-caster has no spellcasting block at all', async () => {
  const character = derive({ ...SPEC, class: 'fighter' }, await progression('2014'));
  assert.equal(character.spellcasting, null);
});

test('a warlock carries pact slots rather than a tier table', async () => {
  const character = derive({ ...SPEC, class: 'warlock', level: 5 }, await progression('2014'));
  assert.deepEqual(character.spellcasting.pact, { slots: 2, level: '3rd' });
  assert.deepEqual(character.spellcasting.slots, {});
});

test('a missing ability score is an error, not a zero', async () => {
  const spec = { ...SPEC, abilities: { str: 14, dex: 8, con: 15, int: 10, wis: 16 } };
  await assert.rejects(
    async () => derive(spec, await progression('2014')),
    /ability "cha" is missing/,
  );
});

test('the same character differs between editions where the rules differ', async () => {
  // A 2024 paladin casts at level 1; a 2014 paladin does not. If the pool were
  // one set of characters with an edition label, this would be wrong on a sheet.
  const spec = { ...SPEC, class: 'paladin', level: 1, skills: [] };
  assert.equal(derive(spec, await progression('2014')).spellcasting.slots['1'], undefined);
  assert.equal(
    derive({ ...spec, edition: '2024' }, await progression('2024')).spellcasting.slots['1'],
    2,
  );
});

test('a pregen fence is read out of a note', () => {
  const note = ['# Someone', '', '```pregen', 'class: rogue', 'level: 3', '```', ''].join('\n');
  assert.deepEqual(parseFence(note), { class: 'rogue', level: 3 });
  assert.equal(parseFence('# Someone\n\nno fence here\n'), null);
});

// --------------------------------------------------------------------------
// The oracle
//
// Five characters that were actually played, in the vault as filled PDFs. The
// derivation is fed nothing but the choices those sheets record — ability
// scores and which skills are ticked — and every derived number is then checked
// against what the sheet prints.
//
// This is the test that matters. Everything above could pass while the whole
// model is wrong; this cannot.
// --------------------------------------------------------------------------

const VAULT =
  process.env.DND_VAULT_PATH ||
  [path.resolve(SCRIPT_DIR, '..', '..', 'DnD'), path.join(os.homedir(), 'DnD')].find(p =>
    existsSync(p),
  ) ||
  null;
const PREGEN_DIR =
  VAULT && path.join(VAULT, '02 Campaigns', 'Dragons of Stormwreck Isle', 'Pregens');

/** How the D&D Beyond export names each skill's total and its tick box. */
const DDB_SKILLS = {
  acrobatics: ['Acrobatics', 'AcrobaticsProf'],
  animal_handling: ['Animal', 'AnimalHandlingProf'],
  arcana: ['Arcana', 'ArcanaProf'],
  athletics: ['Athletics', 'AthleticsProf'],
  deception: ['Deception', 'DeceptionProf'],
  history: ['History', 'HistoryProf'],
  insight: ['Insight', 'InsightProf'],
  intimidation: ['Intimidation', 'IntimidationProf'],
  investigation: ['Investigation', 'InvestigationProf'],
  medicine: ['Medicine', 'MedicineProf'],
  nature: ['Nature', 'NatureProf'],
  perception: ['Perception', 'PerceptionProf'],
  performance: ['Performance', 'PerformanceProf'],
  persuasion: ['Persuasion', 'PersuasionProf'],
  religion: ['Religion', 'ReligionProf'],
  // The export capitalises the tick box and the total differently. Extract, do
  // not retype.
  sleight_of_hand: ['SleightofHand', 'SleightOfHandProf'],
  stealth: ['Stealth', 'StealthProf'],
  survival: ['Survival', 'SurvivalProf'],
};

const DDB_ABILITIES = {
  str: ['STR', 'STRmod', 'ST Strength'],
  dex: ['DEX', 'DEXmod ', 'ST Dexterity'],
  con: ['CON', 'CONmod', 'ST Constitution'],
  int: ['INT', 'INTmod', 'ST Intelligence'],
  wis: ['WIS', 'WISmod', 'ST Wisdom'],
  cha: ['CHA', 'CHamod', 'ST Charisma'],
};

/** Read one exported sheet into a spec plus the numbers it prints. */
function readSheet(file) {
  const fields = fieldMap(readFileSync(file));

  // The export's whitespace is not consistent even within one form: the total
  // is `Stealth ` with a trailing space while its tick box is `StealthProf`
  // without one. Fall back to a trimmed match, but only when exactly one field
  // trims to the name asked for — otherwise a lookup could silently pick the
  // wrong box, and a skill that reads as absent quietly stops being checked.
  const byTrimmed = new Map();
  for (const key of Object.keys(fields)) {
    const trimmed = key.trim();
    if (!byTrimmed.has(trimmed)) byTrimmed.set(trimmed, []);
    byTrimmed.get(trimmed).push(key);
  }
  const at = name => {
    if (name in fields) return fields[name];
    const candidates = byTrimmed.get(name.trim()) ?? [];
    return candidates.length === 1 ? fields[candidates[0]] : null;
  };

  const [, className, level] = /^(\w+)\s+(\d+)$/.exec(at('CLASS  LEVEL')?.trim() ?? '') ?? [];

  const abilities = {};
  const abilityMods = {};
  const saves = {};
  for (const [key, [score, mod, save]] of Object.entries(DDB_ABILITIES)) {
    abilities[key] = Number(at(score));
    abilityMods[key] = at(mod);
    saves[key] = at(save);
  }

  const skills = {};
  const proficient = [];
  const expertise = [];
  for (const [name, [total, prof]] of Object.entries(DDB_SKILLS)) {
    skills[name] = at(total);
    // The tick box carries `P` for proficient and `E` for expertise, which is
    // proficiency counted twice. The Halfling Rogue's Stealth is +7 on DEX +3
    // with a +2 bonus, and reading `E` as merely proficient would print +5.
    const marker = (at(prof) ?? '').trim();
    if (marker === 'P' || marker === 'E') proficient.push(name);
    if (marker === 'E') expertise.push(name);
  }

  return {
    spec: {
      name: at('CharacterName'),
      edition: '2014',
      class: className?.toLowerCase(),
      level: Number(level),
      species: at('RACE'),
      background: at('BACKGROUND'),
      abilities,
      skills: proficient,
      expertise,
      ac: Number(at('AC')),
      hp: Number(at('MaxHP')),
    },
    printed: {
      abilities,
      abilityMods,
      saves,
      skills,
      profBonus: at('ProfBonus'),
      ac: Number(at('AC')),
      hp: Number(at('MaxHP')),
      initiative: at('Init'),
      spellSaveDc: at('spellSaveDC0') ? Number(at('spellSaveDC0')) : undefined,
    },
  };
}

const SHEETS = ['Dwarf_Cleric', 'Elf_Fighter', 'Elf_Wizard', 'Halfling_Rogue', 'Human_Paladin'];
const havePregens = PREGEN_DIR && SHEETS.every(s => existsSync(path.join(PREGEN_DIR, `${s}.pdf`)));
const skip = havePregens ? false : 'vault not mounted';

for (const sheet of SHEETS) {
  test(`${sheet}: every derived number matches the played sheet`, { skip }, async () => {
    const { spec, printed } = readSheet(path.join(PREGEN_DIR, `${sheet}.pdf`));
    const character = derive(spec, await progression('2014'));
    const deltas = compareToSheet(character, printed);
    assert.deepEqual(
      deltas,
      [],
      `${sheet} disagrees with the derivation:\n${deltas.map(d => `  ${d.field}: derived ${d.derived}, sheet ${d.sheet}`).join('\n')}`,
    );
  });
}

test('the oracle actually checked something', { skip }, async () => {
  // A comparison that silently compares nothing would pass forever. This pins
  // the floor: six abilities, six saves and eighteen skills per sheet.
  const { spec, printed } = readSheet(path.join(PREGEN_DIR, 'Dwarf_Cleric.pdf'));
  const character = derive(spec, await progression('2014'));
  assert.equal(Object.keys(character.skills).length, 18);
  assert.equal(Object.values(printed.skills).filter(Boolean).length, 18);
  assert.equal(Object.values(printed.saves).filter(Boolean).length, 6);

  // And it must be able to fail: break one number and the comparison sees it.
  const broken = { ...printed, skills: { ...printed.skills, athletics: '+99' } };
  assert.equal(compareToSheet(character, broken).length, 1);
});
