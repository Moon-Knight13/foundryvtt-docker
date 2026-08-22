#!/usr/bin/env node
// Turn filled character sheets into pool pregen notes, so a pool can be seeded
// from characters that already exist rather than typed from nothing.
//
// The vault holds five finished level-1 characters as D&D Beyond PDF exports
// (Dragons of Stormwreck Isle). Everything a pregen note needs is already in
// them — ability scores, which skills are ticked, AC, hit points — and the rest
// is derived. Reading them is strictly better than retyping them: it is faster,
// it cannot introduce a transcription error, and the result is checked against
// the sheet it came from before it is written.
//
// What is deliberately NOT carried across:
//
//   * the player name. These were exported for a named player; a pool pregen is
//     handed to a stranger and belongs to nobody.
//   * anything game-specific. A pool pregen is a generic chassis — the game's
//     hooks are attached later, by pregen-party.mjs, and only to the copy a
//     game draws. That separation is what stops one game's colour leaking into
//     the next.
//
// Every note is verified before it is written: the character it describes is
// derived and compared field by field against the sheet it was read from. A
// mismatch is refused rather than written, because a pool pregen that disagrees
// with its own source is worse than no pregen.
//
// Usage:
//   node scripts/content/pool-from-sheets.mjs <sheet.pdf>... --out <pool dir>
//     [--edition 2014] [--reference <dir>] [--dry-run]
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fieldMap } from './sheet-fields.mjs';
import { compareToSheet, derive, loadProgression } from './pregen.mjs';

/**
 * How the D&D Beyond export names each skill's total and its tick box.
 *
 * Extracted from real exports, never retyped — note that the tick box and the
 * total disagree about capitalising "of", and that `Stealth ` carries a
 * trailing space its own tick box does not.
 */
export const DDB_SKILLS = {
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
  sleight_of_hand: ['SleightofHand', 'SleightOfHandProf'],
  stealth: ['Stealth', 'StealthProf'],
  survival: ['Survival', 'SurvivalProf'],
};

export const DDB_ABILITIES = {
  str: ['STR', 'STRmod', 'ST Strength'],
  dex: ['DEX', 'DEXmod', 'ST Dexterity'],
  con: ['CON', 'CONmod', 'ST Constitution'],
  int: ['INT', 'INTmod', 'ST Intelligence'],
  wis: ['WIS', 'WISmod', 'ST Wisdom'],
  cha: ['CHA', 'CHamod', 'ST Charisma'],
};

/**
 * Look a field up tolerantly.
 *
 * The export's whitespace is not consistent even within one form, so an exact
 * miss falls back to a trimmed match — but only when exactly one field trims to
 * the name asked for. Otherwise a lookup could quietly pick the wrong box, and
 * a value that reads as absent stops being checked at all.
 */
export function fieldReader(fields) {
  const byTrimmed = new Map();
  for (const key of Object.keys(fields)) {
    const trimmed = key.trim();
    if (!byTrimmed.has(trimmed)) byTrimmed.set(trimmed, []);
    byTrimmed.get(trimmed).push(key);
  }
  return name => {
    if (name in fields) return fields[name];
    const candidates = byTrimmed.get(name.trim()) ?? [];
    return candidates.length === 1 ? fields[candidates[0]] : null;
  };
}

/** Read one exported sheet into a pregen spec plus the numbers it prints. */
export function specFromSheet(bytes, { edition = '2014' } = {}) {
  const at = fieldReader(fieldMap(bytes));

  const classLevel = (at('CLASS  LEVEL') ?? '').trim();
  const [, className, level] = /^([A-Za-z ]+?)\s+(\d+)$/.exec(classLevel) ?? [];
  if (!className) throw new Error(`cannot read a class and level from "${classLevel}"`);

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
    // `P` is proficient and `E` is expertise, which is proficiency counted
    // twice. Reading `E` as merely proficient understates the total.
    const marker = (at(prof) ?? '').trim();
    if (marker === 'P' || marker === 'E') proficient.push(name);
    if (marker === 'E') expertise.push(name);
  }

  const speed = Number(String(at('Speed') ?? '').replace(/[^\d].*$/, '')) || null;

  return {
    spec: {
      name: (at('CharacterName') ?? '').trim(),
      edition,
      class: className.trim().toLowerCase(),
      level: Number(level),
      species: (at('RACE') ?? '').trim() || null,
      background: (at('BACKGROUND') ?? '').trim() || null,
      abilities,
      skills: proficient,
      ...(expertise.length ? { expertise } : {}),
      ac: Number(at('AC')),
      hp: Number(at('MaxHP')),
      ...(speed ? { speed } : {}),
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

const yamlList = values => `[${values.join(', ')}]`;

/** The pool note. Frontmatter for Obsidian, a `pregen` fence for the compiler. */
export function poolNote(spec, { source } = {}) {
  const abilities = Object.entries(spec.abilities)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const lines = [
    '---',
    'type: pregen',
    'system: dnd5e',
    'artifact: [in-person, foundry]',
    `tags: [dnd5e, pregen, ${spec.class}]`,
    '---',
    '',
    `# ${spec.name}`,
    '',
    `A **pool** pregen: a ${spec.species} ${spec.class} at level ${spec.level}, and nothing`,
    'about any particular game. A game draws this one by name in its own',
    "`Pregens.md`, and that game's hooks are attached to the copy it draws — never",
    'here. That is what lets the same character be handed out at two different',
    'tables without carrying anything between them.',
    '',
    'Everything below the choices is derived: proficiency bonus, saves, all',
    'eighteen skill totals, spell slots, save DC, and the features gained by level.',
    'Do not add numbers to this fence that the class table already decides.',
    '',
    '```pregen',
    `name: ${spec.name}`,
    `edition: '${spec.edition}'`,
    `class: ${spec.class}`,
    `level: ${spec.level}`,
    `species: ${spec.species}`,
    `background: ${spec.background}`,
    `abilities: { ${abilities} }`,
    `skills: ${yamlList(spec.skills)}`,
    ...(spec.expertise ? [`expertise: ${yamlList(spec.expertise)}`] : []),
    `ac: ${spec.ac}`,
    ...(spec.speed ? [`speed: ${spec.speed}`] : []),
    `hp: ${spec.hp}`,
    '```',
    '',
    '## Sheet',
    '',
    `Printed from the fence above: \`${spec.name}.pdf\`. Hand it to a player as it`,
    'is, or let a game draw this character and print its own copy with the hooks',
    'that game adds.',
    '',
    `![[${spec.name}.pdf]]`,
    '',
    '> [!note] Provenance',
    source
      ? `> Read from \`${source}\`, then checked against it: every derived number`
      : '> Checked against the sheet it was read from: every derived number',
    '> matches what that sheet prints. The player name was deliberately not',
    '> carried across — a pool pregen belongs to nobody.',
    '',
  ];
  return lines.join('\n');
}

/** Slug used for the note filename and therefore for the party list. */
export function noteName(spec) {
  return `${spec.name}.md`;
}

export function parseArgs(argv) {
  const opts = { sheets: [], edition: '2014', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--edition') opts.edition = argv[++i];
    else if (a === '--reference') opts.reference = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.sheets.push(a);
  }
  if (!opts.sheets.length)
    throw new Error('usage: pool-from-sheets.mjs <sheet.pdf>... --out <dir>');
  if (!opts.out && !opts.dryRun) throw new Error('--out <pool dir> is required');
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const progression = await loadProgression(opts.edition, opts.reference);
  if (!opts.dryRun) await mkdir(opts.out, { recursive: true });

  let failed = 0;
  for (const sheet of opts.sheets) {
    const { spec, printed } = specFromSheet(await readFile(sheet), { edition: opts.edition });
    const character = derive(spec, progression);
    const deltas = compareToSheet(character, printed);

    if (deltas.length) {
      // Refused rather than written: a pool pregen that disagrees with the sheet
      // it came from is worse than not having it.
      failed += 1;
      console.error(`FAIL ${spec.name}: ${deltas.length} value(s) disagree with ${sheet}`);
      for (const d of deltas) console.error(`  ${d.field}: derived ${d.derived}, sheet ${d.sheet}`);
      continue;
    }

    const out = path.join(opts.out ?? '.', noteName(spec));
    const body = poolNote(spec, { source: path.basename(sheet) });
    if (!opts.dryRun) await writeFile(out, body);
    const skills = spec.skills.length;
    console.log(
      `${opts.dryRun ? 'would write' : 'wrote'} ${out} — ${spec.species} ${spec.class} ${spec.level}, ${skills} skills, checked against ${Object.keys(printed.skills).length} printed values`,
    );
  }

  if (failed) throw new Error(`${failed} sheet(s) did not match their own numbers`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
