#!/usr/bin/env node
// Print a derived character onto a real fillable character sheet, so what a
// player is handed at an in-person table is the sheet they already recognise
// rather than a lookalike this repo invented.
//
// This is the write half of the pair that starts with sheet-fields.mjs:
//
//   sheet-fields.mjs  reads a form — what are the boxes called, what is in them
//   sheet-write.mjs   fills one — put these derived numbers in those boxes
//
// The two surfaces of a pregen (the PDF and the Foundry actor) come from one
// calculation. Neither is transcribed from the other, so they cannot drift; the
// anti-drift test asserts the printed Stealth total equals the actor's.
//
// Every form is a separate vocabulary, so nothing here knows a field name.
// Names live in content/reference/sheet-templates.json, keyed by template, and
// each entry pins the blank PDF by checksum. Two consequences:
//
//   * Adding a form — the 2024 sheet, a homebrew layout — is adding a registry
//     entry, not editing this file.
//   * A publisher reissuing a sheet with renamed boxes fails the build instead
//     of quietly producing sheets with gaps where those boxes used to be.
//
// The blanks are publisher-issued and live in the vault, never in this repo.
//
// Usage:
//   node scripts/content/sheet-write.mjs <note.md> --out <sheet.pdf>
//     [--template wotc-2014] [--vault <dir>] [--reference <dir>]
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { compilePregen, signed } from './pregen.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export async function loadTemplates(referenceDir) {
  const dir = referenceDir ?? path.join(REPO_ROOT, 'content', 'reference');
  const file = path.join(dir, 'sheet-templates.json');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return parsed.templates;
}

/**
 * Check a blank is the one the field map was written against.
 *
 * A checksum rather than a field-count check: two different revisions of a form
 * can have the same number of boxes and different names for them.
 */
export function verifyTemplate(bytes, template) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== template.sha256) {
    throw new Error(
      `Template checksum mismatch. Expected ${template.sha256}, got ${sha256}. ` +
        'The blank sheet has changed; its field names may have changed with it, so ' +
        're-extract them (sheet-fields.mjs --names) before trusting this map.',
    );
  }
}

/**
 * The text to write into each mapped box, as a flat name -> value object.
 *
 * Kept separate from the PDF writing so that what lands on paper can be asserted
 * without a PDF in the way, and compared field for field with the actor.
 */
export function sheetValues(character, template) {
  const f = template.fields;
  const values = {};
  const put = (name, value) => {
    if (name && value !== null && value !== undefined && value !== '') values[name] = String(value);
  };

  put(f.characterName, character.name);
  put(
    f.classLevel,
    `${character.className}${character.subclass ? ` (${character.subclass})` : ''} ${character.level}`,
  );
  put(f.race, character.species);
  put(f.background, character.background);
  // Milestone rather than a number: a pregen is levelled by rebuilding it, not
  // by totting up experience, and a zero in this box invites someone to add to it.
  put(f.xp, '(Milestone)');
  put(f.profBonus, signed(character.profBonus));
  put(f.ac, character.ac);
  put(f.initiative, signed(character.initiative));
  put(f.speed, character.speed ? `${character.speed} ft.` : null);
  put(f.hpMax, character.hitPoints.max);
  put(f.hpCurrent, character.hitPoints.max);
  put(f.hitDiceTotal, character.hitDice);
  put(f.hitDice, character.hitDice);
  put(f.passivePerception, character.passivePerception);

  for (const [ability, name] of Object.entries(template.abilityScore ?? {})) {
    put(name, character.abilities[ability].score);
  }
  for (const [ability, name] of Object.entries(template.abilityMod ?? {})) {
    put(name, signed(character.abilities[ability].mod));
  }
  for (const [ability, name] of Object.entries(template.save ?? {})) {
    put(name, signed(character.saves[ability].total));
  }
  for (const [skill, name] of Object.entries(template.skill ?? {})) {
    put(name, signed(character.skills[skill].total));
  }

  if (character.features.length) put(f.features, character.features.join('\n'));

  if (character.spellcasting) {
    put(f.spellcastingClass, character.className);
    put(f.spellcastingAbility, character.spellcasting.ability.toUpperCase());
    put(f.spellSaveDc, character.spellcasting.saveDc);
    put(f.spellAttackBonus, signed(character.spellcasting.attackBonus));
    for (const [tier, count] of Object.entries(character.spellcasting.slots ?? {})) {
      put(template.slotsTotal?.[tier], count);
    }
    if (character.spellcasting.pact) {
      // Pact magic has no tier row on this sheet, so it goes where a reader
      // will actually look for it rather than into a slot box that would read
      // as ordinary spellcasting.
      put(
        f.attacksAndSpellcasting,
        `Pact Magic: ${character.spellcasting.pact.slots} slots at ${character.spellcasting.pact.level} level`,
      );
    }
  }

  return values;
}

/**
 * Refuse to print a character the sheet cannot hold.
 *
 * The binding constraint on this form is three attack rows, and it bites
 * martials rather than casters — there are a hundred spell lines and nine slot
 * tiers. Dropping a weapon silently would put a character at a table missing an
 * attack they are entitled to, so this is an error rather than a truncation.
 */
export function checkCapacity(character, template, attacks = []) {
  const problems = [];
  const rows = template.attackRows ?? template.attacks?.length ?? 0;
  if (attacks.length > rows) {
    problems.push(
      `${attacks.length} attacks but the sheet has ${rows} rows. ` +
        'Cut one or print onto a form with more room — dropping one silently is worse.',
    );
  }
  const highest = Math.max(0, ...Object.keys(character.spellcasting?.slots ?? {}).map(Number));
  const tiers = Object.keys(template.slotsTotal ?? {}).length;
  if (highest > tiers) {
    problems.push(`spell slots up to tier ${highest} but the sheet has ${tiers} tiers`);
  }
  return problems;
}

/**
 * Fill a blank and return the finished PDF bytes.
 *
 * Every mapped name is checked against the form first. A name that has moved
 * would otherwise write nothing at all and leave a blank box on a sheet that
 * looks finished, which is the failure mode most likely to reach a table.
 */
export async function fillSheet(blankBytes, values, { identityFields = [] } = {}) {
  const pdf = await PDFDocument.load(blankBytes);
  const form = pdf.getForm();
  const present = new Set(form.getFields().map(field => field.getName()));

  const missing = Object.keys(values).filter(name => !present.has(name));
  if (missing.length) {
    throw new Error(
      `The template has no field named ${missing.map(m => JSON.stringify(m)).join(', ')}. ` +
        'Field names are extracted, never typed — re-run sheet-fields.mjs --names.',
    );
  }

  for (const [name, value] of Object.entries(values)) {
    form.getTextField(name).setText(value);
  }
  // A pregen handed to a stranger carries nobody's account name.
  for (const name of identityFields) {
    if (present.has(name)) form.getTextField(name).setText('');
  }

  form.updateFieldAppearances();
  return pdf.save();
}

/** Compile a note, derive the character, and print it onto its template. */
export async function writeSheet(notePath, opts = {}) {
  const templates = await loadTemplates(opts.reference);
  const { character } = await compilePregen(notePath, {
    reference: opts.reference,
    hooks: opts.hooks,
  });

  const id = opts.template ?? `wotc-${character.edition}`;
  const template = templates[id];
  if (!template) {
    throw new Error(`Unknown sheet template "${id}". Known: ${Object.keys(templates).join(', ')}`);
  }
  if (template.edition !== character.edition) {
    // A 2024 character on a 2014 form would print numbers the boxes do not
    // mean. The mismatch is an error, never a silent substitution.
    throw new Error(
      `${character.name} is ${character.edition} but template "${id}" is ${template.edition}.`,
    );
  }

  const problems = checkCapacity(character, template, opts.attacks ?? []);
  if (problems.length) throw new Error(problems.join('; '));

  const blankPath = opts.blank ?? path.join(opts.vault ?? '', path.basename(template.file));
  const blankBytes = await readFile(blankPath);
  verifyTemplate(blankBytes, template);

  const values = sheetValues(character, template);
  const bytes = await fillSheet(blankBytes, values, { identityFields: template.identityFields });
  return { bytes, values, character, template };
}

export function parseArgs(argv) {
  const opts = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--template') opts.template = argv[++i];
    else if (a === '--blank') opts.blank = argv[++i];
    else if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--reference') opts.reference = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.notes.push(a);
  }
  if (opts.notes.length !== 1 || !opts.out) {
    throw new Error('usage: sheet-write.mjs <note.md> --out <sheet.pdf> [--blank <template.pdf>]');
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { bytes, character } = await writeSheet(opts.notes[0], opts);
  await writeFile(opts.out, bytes);
  console.log(`${opts.out}: ${character.name} — ${character.className} ${character.level}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
