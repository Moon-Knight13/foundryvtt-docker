#!/usr/bin/env node
// Build a committed reference index of published 5e creatures from Open5e, used
// to check authored stat blocks against the creature they claim to be.
//
// This is the second half of a deliberate pair, and the two answer different
// questions:
//
//   srd-cache.mjs (dnd5e compendium)  "will this render correctly in MY Foundry?"
//   open5e-cache.mjs (this file)      "is this faithful to the PUBLISHED creature?"
//
// A disagreement between them is information, not an error.
//
// Two things this gives that the compendium cannot:
//
//   * `armor_class` as a plain number. The dnd5e packs store
//     {calc: "default", flat: null} for armour-wearing creatures and derive AC at
//     runtime, so Bandit's AC of 12 was simply not checkable before.
//   * `skill_bonus_*` as STATED bonuses, in the same form a Fantasy Statblocks
//     fence writes them. No proficiency-multiplier inference in between.
//
// Source: the open5e-api repository on GitHub, not api.open5e.com. GitHub is
// already reachable, so this needs no firewall change, and the fixtures are the
// same data the API serves. Both editions are published there:
// SRD 5.1 (2014 rules) and SRD 5.2 (2024 rules), both CC-BY-4.0.
//
// Usage:
//   node scripts/content/open5e-cache.mjs [--out <dir>] [--edition 2014|2024]
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const RAW = 'https://raw.githubusercontent.com/open5e/open5e-api/main/data/v2/wizards-of-the-coast';

// `edition` matches the SRD version a statblock note cites in its `source:`
// line, so the note picks which index it is checked against.
export const EDITIONS = [
  { key: '2014', srd: '5.1', dir: 'srd-2014', out: 'open5e-2014.json' },
  { key: '2024', srd: '5.2', dir: 'srd-2024', out: 'open5e-2024.json' },
];

// Open5e spells sizes out; dnd5e (and therefore statblock.mjs's verify) uses
// abbreviations. Comparing 'large' against 'lg' would flag every creature.
const SIZES = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

const ABILITIES = {
  str: 'ability_score_strength',
  dex: 'ability_score_dexterity',
  con: 'ability_score_constitution',
  int: 'ability_score_intelligence',
  wis: 'ability_score_wisdom',
  cha: 'ability_score_charisma',
};

const SAVES = {
  str: 'saving_throw_strength',
  dex: 'saving_throw_dexterity',
  con: 'saving_throw_constitution',
  int: 'saving_throw_intelligence',
  wis: 'saving_throw_wisdom',
  cha: 'saving_throw_charisma',
};

// dnd5e skill keys, keyed by the Open5e field suffix. Note the three that are
// routinely confused: per = Persuasion, prc = Perception, prf = Performance.
const SKILLS = {
  acrobatics: 'acr',
  animal_handling: 'ani',
  arcana: 'arc',
  athletics: 'ath',
  deception: 'dec',
  history: 'his',
  insight: 'ins',
  intimidation: 'itm',
  investigation: 'inv',
  medicine: 'med',
  nature: 'nat',
  perception: 'prc',
  performance: 'prf',
  persuasion: 'per',
  religion: 'rel',
  sleight_of_hand: 'slt',
  stealth: 'ste',
  survival: 'sur',
};

const SPEEDS = ['walk', 'fly', 'swim', 'climb', 'burrow'];
const SENSES = {
  darkvision_range: 'darkvision',
  blindsight_range: 'blindsight',
  tremorsense_range: 'tremorsense',
  truesight_range: 'truesight',
};

function num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reduce an Open5e creature to the same record shape srd-cache.mjs emits, so
 * statblock.mjs's verify() consumes either without knowing the difference.
 */
export function distill(fields) {
  const abilities = {};
  for (const [key, field] of Object.entries(ABILITIES)) abilities[key] = num(fields[field]);

  const saves = {};
  for (const [key, field] of Object.entries(SAVES)) {
    const v = num(fields[field]);
    if (v !== undefined) saves[key] = v;
  }

  const skills = {};
  for (const [suffix, key] of Object.entries(SKILLS)) {
    const v = num(fields[`skill_bonus_${suffix}`]);
    if (v !== undefined) skills[key] = v;
  }

  const speed = {};
  for (const k of SPEEDS) {
    const v = num(fields[k]);
    if (v !== undefined && v > 0) speed[k] = v;
  }

  const senses = {};
  for (const [field, key] of Object.entries(SENSES)) {
    const v = num(fields[field]);
    if (v !== undefined && v > 0) senses[key] = v;
  }

  return {
    name: fields.name,
    // Always a real number here — the reason this source exists alongside the
    // compendium, where armour-wearing creatures have no comparable value.
    ac: num(fields.armor_class),
    acDetail: fields.armor_detail || undefined,
    hp: num(fields.hit_points),
    hpFormula: fields.hit_dice || undefined,
    // challenge_rating arrives as a string like "4.000".
    cr: num(fields.challenge_rating),
    size: SIZES[String(fields.size ?? '').toLowerCase()],
    type: String(fields.type ?? '').toLowerCase() || undefined,
    abilities,
    ...(Object.keys(saves).length ? { saves } : {}),
    // STATED bonuses, directly comparable with a fence's `skillsaves`.
    ...(Object.keys(skills).length ? { skills } : {}),
    speed,
    senses,
    languages: fields.languages_desc || '',
  };
}

/** Index distilled records by creature name, sorted for a stable diff. */
export function open5eIndex(records) {
  const out = {};
  for (const r of records) {
    const fields = r?.fields ?? r;
    if (!fields?.name) continue;
    out[fields.name] = distill(fields);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function creatureUrl(dir) {
  return `${RAW}/${dir}/Creature.json`;
}

export async function fetchCreatures(dir, fetchImpl = fetch) {
  const url = creatureUrl(dir);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `${url} returned ${res.status}. GitHub is normally reachable from here; ` +
        'if this is a connection failure rather than a 404, check egress.',
    );
  }
  return res.json();
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--edition') opts.edition = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  opts.out ??= path.join(REPO_ROOT, 'content', 'reference');
  if (opts.edition && !EDITIONS.some(e => e.key === opts.edition)) {
    throw new Error(`Unknown edition "${opts.edition}" — expected 2014 or 2024`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  await mkdir(opts.out, { recursive: true });

  const wanted = EDITIONS.filter(e => !opts.edition || e.key === opts.edition);
  for (const edition of wanted) {
    const creatures = open5eIndex(await fetchCreatures(edition.dir));
    const dest = path.join(opts.out, edition.out);
    await writeFile(
      dest,
      `${JSON.stringify(
        {
          edition: edition.key,
          srd: edition.srd,
          source: `open5e-api/data/v2/wizards-of-the-coast/${edition.dir}`,
          licence: 'CC-BY-4.0',
          creatures,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`${dest}: ${Object.keys(creatures).length} creatures (SRD ${edition.srd})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
