import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { fieldMap, readFields } from './sheet-fields.mjs';
import { derive, toCharacterActor } from './pregen.mjs';
import {
  checkCapacity,
  fillSheet,
  loadTemplates,
  sheetValues,
  verifyTemplate,
} from './sheet-write.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.resolve(SCRIPT_DIR, '..', '..', 'content', 'reference');

const progression = async edition =>
  JSON.parse(await readFile(path.join(REFERENCE, `progression-${edition}.json`), 'utf8'));

const SPEC = {
  name: 'Elf Wizard',
  edition: '2014',
  class: 'wizard',
  level: 5,
  species: 'High Elf',
  background: 'Sage',
  abilities: { str: 10, dex: 15, con: 14, int: 16, wis: 12, cha: 8 },
  skills: ['Arcana', 'History', 'Insight', 'Investigation', 'Perception'],
  ac: 12,
  speed: 30,
};

const wotc2014 = async () => (await loadTemplates())['wotc-2014'];

test('the registry keeps whitespace exactly as the form spells it', async () => {
  // Every one of these looks like a typo and is not. Retyping any of them
  // writes to a box that does not exist.
  const t = await wotc2014();
  assert.equal(t.skill.stealth, 'Stealth ');
  assert.equal(t.skill.deception, 'Deception ');
  assert.equal(t.fields.race, 'Race ');
  assert.equal(t.abilityMod.dex, 'DEXmod ');
  assert.equal(t.abilityMod.cha, 'CHamod');
  assert.equal(t.fields.spellSaveDc, 'SpellSaveDC  2');
  assert.equal(t.attacks[2].bonus, 'Wpn3 AtkBonus  ');
});

test('every derived number reaches a named box', async () => {
  const character = derive(SPEC, await progression('2014'));
  const values = sheetValues(character, await wotc2014());
  assert.equal(values.CharacterName, 'Elf Wizard');
  assert.equal(values.ClassLevel, 'Wizard 5');
  assert.equal(values['Race '], 'High Elf');
  assert.equal(values.ProfBonus, '+3');
  assert.equal(values.INT, '16');
  assert.equal(values.INTmod, '+3');
  assert.equal(values['ST Intelligence'], '+6', 'wizards are proficient in INT saves');
  assert.equal(values.Arcana, '+6');
  assert.equal(values['Stealth '], '+2', 'DEX +2, unproficient');
  assert.equal(values.HPMax, String(character.hitPoints.max));
  assert.equal(values['SlotsTotal 21'], '2', 'two 3rd-level slots at wizard 5');
  assert.equal(values['SpellSaveDC  2'], '14');
});

test('experience reads as milestone rather than a number', async () => {
  // A zero in the box invites someone to start adding to it. A pregen is
  // levelled by rebuilding it.
  const values = sheetValues(derive(SPEC, await progression('2014')), await wotc2014());
  assert.equal(values.XP, '(Milestone)');
});

test('a non-caster gets no spellcasting boxes', async () => {
  const character = derive({ ...SPEC, class: 'fighter' }, await progression('2014'));
  const values = sheetValues(character, await wotc2014());
  assert.equal(values['SpellSaveDC  2'], undefined);
  assert.equal(values['SlotsTotal 19'], undefined);
});

test('pact magic goes where a reader will look for it', async () => {
  // There is no pact row on this form, and writing pact slots into a tier box
  // would read as ordinary spellcasting.
  const character = derive({ ...SPEC, class: 'warlock', level: 5 }, await progression('2014'));
  const values = sheetValues(character, await wotc2014());
  assert.match(values.AttacksSpellcasting, /Pact Magic: 2 slots at 3rd level/);
  assert.equal(values['SlotsTotal 21'], undefined);
});

test('a fourth attack is refused, not quietly dropped', async () => {
  // Three rows is this form's binding constraint, and it bites martials rather
  // than casters. A character arriving at a table missing an attack they are
  // entitled to is worse than a build that stops.
  const character = derive(SPEC, await progression('2014'));
  const template = await wotc2014();
  assert.deepEqual(checkCapacity(character, template, ['a', 'b', 'c']), []);
  const problems = checkCapacity(character, template, ['a', 'b', 'c', 'd']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /4 attacks but the sheet has 3 rows/);
});

test('a changed blank fails the build rather than printing gaps', async () => {
  const template = await wotc2014();
  assert.throws(() => verifyTemplate(Buffer.from('not the sheet'), template), /checksum mismatch/);
  // And the pin is the real file's checksum, not a placeholder.
  assert.match(template.sha256, /^[0-9a-f]{64}$/);
});

/** A small fillable form, so the writer can be tested without the vault. */
async function blankTemplate(names) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const form = pdf.getForm();
  names.forEach((name, i) => {
    const field = form.createTextField(name);
    field.addToPage(page, { x: 20, y: 750 - i * 30, width: 200, height: 20 });
  });
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

test('a field the form does not have is an error, not a blank box', async () => {
  // The failure this prevents: a renamed box writes nothing, and the sheet
  // still looks finished. That is the version most likely to reach a table.
  const blank = await blankTemplate(['CharacterName']);
  await assert.rejects(
    fillSheet(blank, { CharacterName: 'Someone', Nonexistent: 'x' }),
    /no field named "Nonexistent"/,
  );
});

test('what is written comes back off the page', async () => {
  const blank = await blankTemplate(['CharacterName', 'Stealth ', 'ProfBonus']);
  const filled = await fillSheet(blank, {
    CharacterName: 'Elf Wizard',
    'Stealth ': '+2',
    ProfBonus: '+3',
  });
  const read = fieldMap(Buffer.from(filled));
  assert.equal(read.CharacterName, 'Elf Wizard');
  assert.equal(read['Stealth '], '+2', 'the trailing space survived the round trip');
  assert.equal(read.ProfBonus, '+3');
});

test('a generated sheet carries no account name', async () => {
  // The vault's own exports carry PLAYER NAME = Moon_Knight22250, because they
  // were exported for a named player. A pregen is handed to a stranger.
  const blank = await blankTemplate(['CharacterName', 'PlayerName']);
  const seeded = await fillSheet(blank, { PlayerName: 'someone-real' });
  assert.equal(fieldMap(Buffer.from(seeded)).PlayerName, 'someone-real', 'seeded on purpose');

  const filled = await fillSheet(
    Buffer.from(seeded),
    { CharacterName: 'Elf Wizard' },
    { identityFields: ['PlayerName'] },
  );
  // Blanking drops the value outright rather than storing an empty string, so
  // the box has no value at all. Either reads as empty; this is the stronger of
  // the two, and both are what "carries nobody's name" means.
  assert.ok(!fieldMap(Buffer.from(filled)).PlayerName);
});

test('the printed sheet and the Foundry actor cannot disagree', async () => {
  // The anti-drift claim, asserted rather than asserted-about: both surfaces
  // come from one calculation, so a change to the derivation moves both or
  // fails the build.
  const character = derive(SPEC, await progression('2014'));
  const template = await wotc2014();
  const values = sheetValues(character, template);
  const { actor } = toCharacterActor(character);

  // Stealth: unproficient, so the actor writes no entry and the total is the
  // bare modifier. Proficiency has to agree in both directions.
  assert.equal(values['Stealth '], '+2');
  assert.equal(actor.system.skills.ste, undefined);

  // Arcana: proficient in both, and the printed total is what the multiplier
  // plus the modifier comes to.
  assert.equal(actor.system.skills.arc.value, 1);
  assert.equal(
    values.Arcana,
    `+${character.abilities.int.mod + actor.system.skills.arc.value * character.profBonus}`,
  );

  assert.equal(values.AC, String(actor.system.attributes.ac.flat));
  assert.equal(values.HPMax, String(actor.system.attributes.hp.max));
  assert.equal(values['SlotsTotal 21'], String(actor.system.spells.spell3.value));
  assert.equal(values['ST Intelligence'], '+6');
  assert.equal(actor.system.abilities.int.proficient, 1);
});

// --------------------------------------------------------------------------
// The real blank
// --------------------------------------------------------------------------

const VAULT =
  process.env.DND_VAULT_PATH ||
  [path.resolve(SCRIPT_DIR, '..', '..', 'DnD'), path.join(os.homedir(), 'DnD')].find(p =>
    existsSync(p),
  ) ||
  null;
const BLANK =
  VAULT && path.join(VAULT, '01 Systems', 'dnd5e', 'Pregens', 'templates', 'wotc-2014.pdf');
const skip = BLANK && existsSync(BLANK) ? false : 'vault not mounted';

test('every name in the registry exists on the real form', { skip }, async () => {
  const template = await wotc2014();
  const present = new Set(readFields(await readFile(BLANK)).map(f => f.name));
  const mapped = [
    ...Object.values(template.fields),
    ...Object.values(template.abilityScore),
    ...Object.values(template.abilityMod),
    ...Object.values(template.save),
    ...Object.values(template.skill),
    ...Object.values(template.slotsTotal),
    ...template.attacks.flatMap(a => [a.name, a.bonus, a.damage]),
    ...template.identityFields,
  ];
  const missing = mapped.filter(name => !present.has(name));
  assert.deepEqual(
    missing,
    [],
    `names not on the form: ${missing.map(m => JSON.stringify(m)).join(', ')}`,
  );
  assert.ok(mapped.length >= 80, 'the map should cover the sheet, not a corner of it');
});

test('the pinned checksum is the blank actually on the shelf', { skip }, async () => {
  const template = await wotc2014();
  const bytes = await readFile(BLANK);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), template.sha256);
  verifyTemplate(bytes, template);
});

test('a character prints onto the real sheet and reads back correctly', { skip }, async () => {
  const character = derive(SPEC, await progression('2014'));
  const template = await wotc2014();
  const values = sheetValues(character, template);
  const filled = await fillSheet(await readFile(BLANK), values, {
    identityFields: template.identityFields,
  });

  const read = fieldMap(Buffer.from(filled));
  assert.equal(read.CharacterName, 'Elf Wizard');
  assert.equal(read['Race '], 'High Elf');
  assert.equal(read.INT, '16');
  assert.equal(read['ST Intelligence'], '+6');
  assert.equal(read.Arcana, '+6');
  assert.equal(read['Stealth '], '+2');
  assert.equal(read['SlotsTotal 21'], '2');
  assert.ok(!read.PlayerName, 'no account name on a sheet handed to a stranger');
});
