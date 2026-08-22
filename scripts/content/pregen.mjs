#!/usr/bin/env node
// Derive a playable character from a short authored spec plus the cached class
// tables, so that everything a class table decides is computed and only the
// things a player actually chooses are written down.
//
// The split matters, and where it falls was settled by measuring the source
// rather than by preference:
//
//   DERIVED, never authored — proficiency bonus, saving throws, skill totals,
//   spell slots, spell save DC and attack bonus, cantrips and prepared spells,
//   the features gained by level. All of it comes from
//   content/reference/progression-{2014,2024}.json, which is checked against an
//   independent source. This is the half that produces silent, plausible errors
//   when it is typed by hand.
//
//   AUTHORED, then checked — ability scores, which skills the character is
//   proficient in, armour class, walking speed. These are choices, and a
//   generator that invented them would be inventing the character.
//
// Species and background sit on the authored side for a reason worth recording.
// Open5e publishes them as prose, not data: a dwarf's ability increase is the
// sentence "Your Constitution score increases by 2." and its speed is "Your base
// walking speed is 25 feet." Parsing numbers back out of English is precisely
// the guessing that pregen-cache.mjs refuses to do with class tables, so this
// does not do it either. The author states the final scores — which is what the
// sheet prints anyway — and everything downstream is derived from them.
//
// The SRD is also thinner here than anywhere else, which bounds how varied a
// pool can be: 2014 publishes ONE background (Acolyte) and 2024 publishes four
// (Acolyte, Criminal, Sage, Soldier). That is a fact about the SRD, not about
// this pipeline, but it is the reason a game's hook table keys off a closed
// vocabulary — the vocabulary is genuinely closed.
//
// Nothing here caps a level. The tables run to 20 and so does this.
//
// Usage:
//   node scripts/content/pregen.mjs <note.md> [--reference <dir>]
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { abilityMod } from './statblock.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * Which ability each skill runs off, and the dnd5e key for it.
 *
 * Fixed by the rules and identical in both editions, so this is a constant
 * rather than a lookup. The three that get confused: per = Persuasion,
 * prc = Perception, prf = Performance.
 */
export const SKILLS = {
  acrobatics: { key: 'acr', ability: 'dex' },
  animal_handling: { key: 'ani', ability: 'wis' },
  arcana: { key: 'arc', ability: 'int' },
  athletics: { key: 'ath', ability: 'str' },
  deception: { key: 'dec', ability: 'cha' },
  history: { key: 'his', ability: 'int' },
  insight: { key: 'ins', ability: 'wis' },
  intimidation: { key: 'itm', ability: 'cha' },
  investigation: { key: 'inv', ability: 'int' },
  medicine: { key: 'med', ability: 'wis' },
  nature: { key: 'nat', ability: 'int' },
  perception: { key: 'prc', ability: 'wis' },
  performance: { key: 'prf', ability: 'cha' },
  persuasion: { key: 'per', ability: 'cha' },
  religion: { key: 'rel', ability: 'int' },
  sleight_of_hand: { key: 'slt', ability: 'dex' },
  stealth: { key: 'ste', ability: 'dex' },
  survival: { key: 'sur', ability: 'wis' },
};

/**
 * Spellcasting ability by class.
 *
 * Hardcoded, unlike everything else, and the distinction is deliberate: this is
 * one fixed fact per class that both editions agree on and that does not vary by
 * level, whereas a class TABLE has twenty rows that change between editions and
 * is exactly what gets mistyped. Open5e does not publish this field at all.
 */
export const SPELLCASTING_ABILITY = {
  bard: 'cha',
  cleric: 'wis',
  druid: 'wis',
  paladin: 'cha',
  ranger: 'wis',
  sorcerer: 'cha',
  warlock: 'cha',
  wizard: 'int',
};

/** Normalise a skill written as `Animal Handling`, `animal-handling`, `ani`. */
export function skillKey(label) {
  const normalised = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (SKILLS[normalised]) return normalised;
  return Object.keys(SKILLS).find(name => SKILLS[name].key === normalised) ?? null;
}

/** `+3` rather than `3`, because a sheet prints the sign. */
export function signed(value) {
  return `${value >= 0 ? '+' : ''}${value}`;
}

/** Extract the first ```pregen fence from note markdown. Null if absent. */
export function parseFence(markdown) {
  const match = markdown.match(/```pregen\r?\n([\s\S]*?)```/);
  if (!match) return null;
  return yaml.load(match[1]) ?? null;
}

/**
 * Average hit points per level after the first.
 *
 * Pregens take the fixed average rather than rolling, because a sheet handed to
 * a stranger has to be reproducible: rebuilding the same pregen must produce the
 * same character, and a roll would make every rebuild a different one.
 */
export function hpPerLevel(hitDie, conMod) {
  return Math.floor(hitDie / 2) + 1 + conMod;
}

/** Maximum hit points at a level: full die at 1st, fixed average thereafter. */
export function deriveHitPoints(hitDie, conMod, level, bonusPerLevel = 0) {
  const first = hitDie + conMod + bonusPerLevel;
  const rest = (level - 1) * (hpPerLevel(hitDie, conMod) + bonusPerLevel);
  return first + rest;
}

/**
 * Everything the class table says a character of this class and level has.
 *
 * Features accumulate: a level-5 fighter still has what it gained at 1, so the
 * sheet lists all of it rather than only the newest line.
 */
export function classProgress(progression, className, level, subclassName = null) {
  const cls = progression.classes?.[className];
  if (!cls) {
    const known = Object.keys(progression.classes ?? {}).join(', ');
    throw new Error(
      `Unknown class "${className}" for the ${progression.edition} tables. Known: ${known}`,
    );
  }
  if (!Number.isInteger(level) || level < 1 || level > 20) {
    throw new Error(`Level ${level} is out of range — class tables cover 1 to 20.`);
  }

  const features = [];
  let profBonus = null;
  let slots = {};
  let pact = null;
  let tracks = {};

  for (let l = 1; l <= level; l += 1) {
    const entry = cls.levels?.[String(l)];
    if (!entry) continue;
    if (entry.profBonus !== undefined) profBonus = entry.profBonus;
    if (entry.slots) slots = entry.slots;
    if (entry.pact) pact = entry.pact;
    if (entry.tracks) tracks = { ...tracks, ...entry.tracks };
    if (entry.features) features.push(...entry.features);
  }

  let subclass = null;
  if (subclassName) {
    subclass = cls.subclasses?.[subclassName];
    if (!subclass) {
      const known = Object.keys(cls.subclasses ?? {}).join(', ') || 'none in the SRD';
      throw new Error(`Unknown subclass "${subclassName}" for ${className}. Known: ${known}`);
    }
    for (let l = 1; l <= level; l += 1) {
      const entry = subclass.levels?.[String(l)];
      if (entry?.features) features.push(...entry.features);
    }
  }

  return {
    name: cls.name,
    hitDie: cls.hitDie,
    saves: cls.saves,
    casterType: cls.casterType,
    subclassName: subclass ? subclass.name : null,
    profBonus,
    slots,
    pact,
    tracks,
    features,
  };
}

/**
 * Turn an authored spec plus the class tables into a complete character.
 *
 * Returns the numbers a sheet prints, so that the printed sheet and the Foundry
 * actor are two renderings of one calculation rather than two calculations that
 * have to be kept in step.
 */
export function derive(spec, progression) {
  const level = Number(spec.level);
  const className = String(spec.class ?? '').toLowerCase();
  const progress = classProgress(progression, className, level, spec.subclass ?? null);
  const pb = progress.profBonus;

  const scores = {};
  const mods = {};
  for (const ability of ABILITIES) {
    const score = Number(spec.abilities?.[ability]);
    if (!Number.isFinite(score)) {
      throw new Error(
        `${spec.name ?? 'pregen'}: ability "${ability}" is missing. All six are authored.`,
      );
    }
    scores[ability] = score;
    mods[ability] = abilityMod(score);
  }

  const saves = {};
  for (const ability of ABILITIES) {
    const proficient = progress.saves.includes(ability);
    saves[ability] = { proficient, total: mods[ability] + (proficient ? pb : 0) };
  }

  const proficient = new Set();
  for (const label of spec.skills ?? []) {
    const key = skillKey(label);
    if (!key) throw new Error(`${spec.name ?? 'pregen'}: "${label}" is not a skill.`);
    proficient.add(key);
  }
  const expert = new Set();
  for (const label of spec.expertise ?? []) {
    const key = skillKey(label);
    if (!key) throw new Error(`${spec.name ?? 'pregen'}: "${label}" is not a skill.`);
    if (!proficient.has(key)) {
      // Expertise doubles proficiency. Without proficiency there is nothing to
      // double, and the sheet would print a bonus the character cannot have.
      throw new Error(
        `${spec.name ?? 'pregen'}: expertise in "${label}" without proficiency in it.`,
      );
    }
    expert.add(key);
  }

  const skills = {};
  for (const [name, { key, ability }] of Object.entries(SKILLS)) {
    const multiplier = expert.has(name) ? 2 : proficient.has(name) ? 1 : 0;
    skills[name] = {
      key,
      ability,
      multiplier,
      total: mods[ability] + multiplier * pb,
    };
  }

  const spellAbility = SPELLCASTING_ABILITY[className] ?? null;
  const spellcasting =
    progress.casterType === 'none' || !spellAbility
      ? null
      : {
          ability: spellAbility,
          saveDc: 8 + pb + mods[spellAbility],
          attackBonus: pb + mods[spellAbility],
          slots: progress.slots,
          pact: progress.pact,
          cantrips: Number(progress.tracks.cantrips ?? progress.tracks['cantrips-known']) || null,
          prepared: Number(progress.tracks['prepared-spells']) || null,
        };

  const hpBonusPerLevel = Number(spec.hp_bonus_per_level ?? 0) || 0;
  const derivedHp = deriveHitPoints(progress.hitDie, mods.con, level, hpBonusPerLevel);

  return {
    name: spec.name ?? null,
    edition: progression.edition,
    className: progress.name,
    classSlug: className,
    subclass: progress.subclassName,
    level,
    species: spec.species ?? null,
    background: spec.background ?? null,
    profBonus: pb,
    abilities: Object.fromEntries(ABILITIES.map(a => [a, { score: scores[a], mod: mods[a] }])),
    saves,
    skills,
    hitPoints: { max: spec.hp !== undefined ? Number(spec.hp) : derivedHp, derived: derivedHp },
    hitDice: `${level}d${progress.hitDie}`,
    ac: spec.ac !== undefined ? Number(spec.ac) : null,
    initiative: mods.dex,
    speed: spec.speed !== undefined ? Number(spec.speed) : null,
    passivePerception: 10 + skills.perception.total,
    spellcasting,
    features: [...new Set(progress.features)].sort(),
    tracks: progress.tracks,
  };
}

/**
 * Compare a derived character against the numbers printed on a real sheet.
 *
 * The point is not to grade the sheet — it is to grade this module. The vault
 * holds five finished characters that somebody played, and if the derivation
 * disagrees with them then the derivation is wrong.
 *
 * Returns deltas rather than throwing, in the same shape statblock.mjs's
 * verify() uses, because a difference is information a person should look at.
 */
export function compareToSheet(derived, printed) {
  const deltas = [];
  const cmp = (field, mine, theirs) => {
    if (theirs === undefined || theirs === null || theirs === '') return;
    if (String(mine) !== String(theirs)) deltas.push({ field, derived: mine, sheet: theirs });
  };

  for (const ability of ABILITIES) {
    cmp(`${ability}.score`, derived.abilities[ability].score, printed.abilities?.[ability]);
    cmp(`${ability}.mod`, signed(derived.abilities[ability].mod), printed.abilityMods?.[ability]);
    cmp(`save.${ability}`, signed(derived.saves[ability].total), printed.saves?.[ability]);
  }
  for (const [name, skill] of Object.entries(derived.skills)) {
    cmp(`skill.${name}`, signed(skill.total), printed.skills?.[name]);
  }
  cmp('profBonus', signed(derived.profBonus), printed.profBonus);
  cmp('hp', derived.hitPoints.max, printed.hp);
  cmp('ac', derived.ac, printed.ac);
  cmp('initiative', signed(derived.initiative), printed.initiative);
  cmp('passivePerception', derived.passivePerception, printed.passivePerception);
  if (derived.spellcasting) {
    cmp('spellSaveDc', derived.spellcasting.saveDc, printed.spellSaveDc);
    cmp('spellAttack', signed(derived.spellcasting.attackBonus), printed.spellAttack);
  }
  return deltas;
}

export async function loadProgression(edition, referenceDir) {
  const dir = referenceDir ?? path.join(REPO_ROOT, 'content', 'reference');
  const file = path.join(dir, `progression-${edition}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read ${file}: ${err.message}. Build it with: node scripts/content/pregen-cache.mjs`,
    );
  }
}

export function parseArgs(argv) {
  const opts = { notes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reference') opts.reference = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.notes.push(a);
  }
  if (opts.notes.length !== 1) throw new Error('usage: pregen.mjs <note.md> [--reference <dir>]');
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const markdown = await readFile(opts.notes[0], 'utf8');
  const spec = parseFence(markdown);
  if (!spec) throw new Error(`${opts.notes[0]} has no \`\`\`pregen fence.`);

  const progression = await loadProgression(spec.edition ?? '2014', opts.reference);
  const character = derive(spec, progression);
  console.log(JSON.stringify(character, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
