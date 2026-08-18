#!/usr/bin/env node
// Compile a vault note's ```statblock fence into a dnd5e actor document, and
// check it against the SRD creature it says it was written from.
//
// The fence is the in-person artifact — Fantasy Statblocks renders it as a
// printable card — and it already holds every field the Foundry actor needs.
// Before this script, that second projection was produced by hand ("Claude
// compiles this same data into the Foundry actor JSON", per the NPC template),
// which is both the most repeated step in the pipeline and the one nothing
// checked. Compiling it removes the transcription entirely.
//
// Usage:
//   node scripts/content/statblock.mjs <note.md> [--out <actor.json>]
//                                      [--srd <content/reference/srd-51.json>]
//
// One note in, one actor out. The actor's NAME comes from the note's filename,
// not the fence's `name:` — the card may read "Vashti (Lamia)" while the actor
// is "Vashti".
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { resolveArt } from './art-resolve.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_ART_MAP = path.join(REPO_ROOT, 'content', 'reference', 'art-map.json');

// Fantasy Statblocks skill labels -> dnd5e skill keys. Note the three that are
// routinely confused: per = Persuasion, prc = Perception, prf = Performance.
export const SKILL_KEYS = {
  acrobatics: 'acr',
  'animal handling': 'ani',
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
  'sleight of hand': 'slt',
  stealth: 'ste',
  survival: 'sur',
};

export const ABILITY_KEYS = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SIZES = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

/** "1/8" -> 0.125. Stat blocks write CR as a fraction; YAML yields a string. */
export function parseCR(cr) {
  if (typeof cr === 'number') return cr;
  if (typeof cr !== 'string') return 0;
  const frac = cr.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(cr);
  return Number.isFinite(n) ? n : 0;
}

export function abilityMod(score) {
  return Math.floor((Number(score) - 10) / 2);
}

/** Proficiency bonus from challenge rating (SRD table). */
export function profBonus(cr) {
  const n = parseCR(cr);
  if (!Number.isFinite(n)) return 2;
  return Math.max(2, 2 + Math.ceil(Math.max(0, n - 4) / 4));
}

/**
 * Turn a stated skill/save bonus into how dnd5e stores it.
 *
 * dnd5e does not store the bonus — it stores a proficiency multiplier and
 * derives the number. A stat block that says "Deception +7" on a CHA 16, CR 4
 * creature means expertise (3 + 2*2), not proficiency (3 + 2 = +5). Writing
 * `value: 1` there silently shows +5 at the table, and nothing catches it.
 *
 * Returns the multiplier plus, when the bonus is not reachable by any
 * multiplier, the flat remainder to put in `bonuses.check` — and a note saying
 * so, because that case is usually a typo rather than a real flat bonus.
 */
export function skillProficiency(stated, mod, pb) {
  const need = Number(stated) - mod;
  for (const value of [0, 1, 2]) {
    if (need === value * pb) return { value, flat: 0 };
  }
  // Closest multiplier that does not overshoot, remainder carried flat.
  const value = need > 2 * pb ? 2 : need > pb ? 1 : need > 0 ? 1 : 0;
  return {
    value,
    flat: need - value * pb,
    note:
      `+${stated} is not reachable from a ${mod >= 0 ? '+' : ''}${mod} modifier ` +
      `with proficiency ${pb}; storing multiplier ${value} plus a flat ${need - value * pb}`,
  };
}

/** Extract the first ```statblock fence from note markdown. Null if absent. */
export function parseFence(markdown) {
  const m = markdown.match(/```statblock\r?\n([\s\S]*?)```/);
  if (!m) return null;
  return yaml.load(m[1]) ?? null;
}

/**
 * Read the note's YAML frontmatter. Some facts about an NPC are not stat-block
 * facts — an NPC built on the SRD Spy may start the session as an ally, so its
 * token disposition is neutral rather than hostile. That belongs to the note,
 * not to the shared SRD stat line.
 */
export function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  return yaml.load(m[1]) ?? {};
}

/** Foundry's default actor art. Valid, but a blank silhouette at the table. */
export const PLACEHOLDER_IMG = 'icons/svg/mystery-man.svg';

const DISPOSITIONS = { hostile: -1, neutral: 0, friendly: 1, secret: -2 };

/** Frontmatter `disposition:` accepts a word or the raw Foundry number. */
export function parseDisposition(value, fallback = -1) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const key = String(value).trim().toLowerCase();
  return DISPOSITIONS[key] ?? fallback;
}

/**
 * Pick the Open5e index matching the edition a note cites.
 *
 * This is load-bearing, not tidiness: the 2024 rules genuinely restat
 * creatures. The SRD Lamia is a monstrosity with Stealth +3 in 5.1 and a fiend
 * with Stealth +5 in 5.2, and the SRD Spy is Medium in 5.1 and Small in 5.2.
 * Checking a note written from one edition against the other invents deltas.
 */
export function open5eFor(edition, referenceDir) {
  const dir = referenceDir ?? path.join(REPO_ROOT, 'content', 'reference');
  if (edition === '5.2') return path.join(dir, 'open5e-2024.json');
  if (edition === '5.1') return path.join(dir, 'open5e-2014.json');
  return null;
}

/** Same routing for the dnd5e compendium cache, which carries the token ART
 * that Open5e lacks. The note names its edition; art inheritance must not
 * need a hand-passed --srd once the cache exists. */
export function srdFor(edition, referenceDir) {
  const dir = referenceDir ?? path.join(REPO_ROOT, 'content', 'reference');
  if (edition === '5.2') return path.join(dir, 'srd-52.json');
  if (edition === '5.1') return path.join(dir, 'srd-51.json');
  return null;
}

/** "SRD 5.1 (CC-BY-4.0) — Lamia" -> { edition: '5.1', base: 'Lamia' } */
export function parseSource(source) {
  if (typeof source !== 'string') return {};
  const edition = source.match(/SRD\s+(\d+\.\d+)/)?.[1];
  // The base creature is whatever follows the em dash (or a plain hyphen).
  const base =
    source
      .split(/\s+[—–-]\s+/)
      .slice(1)
      .join(' - ')
      .trim() || undefined;
  return { edition, base };
}

/** "30 ft." / "30 ft., fly 60 ft." -> { walk: 30, fly: 60, units: 'ft' } */
export function parseSpeed(speed) {
  if (typeof speed !== 'string') return { units: 'ft' };
  const out = { units: 'ft' };
  for (const part of speed.split(',')) {
    const m = part.trim().match(/^(?:(\w+)\s+)?(\d+)\s*ft/i);
    if (m) out[(m[1] ?? 'walk').toLowerCase()] = Number(m[2]);
  }
  return out;
}

/**
 * "darkvision 60 ft., passive Perception 12" -> { darkvision: 60, units: 'ft' }
 *
 * Passive Perception is derived by the system, not stored, so it is ignored.
 * A creature with no special senses gets {} rather than a units-only object —
 * writing units alone is noise the hand-authored actors did not carry either.
 */
export function parseSenses(senses) {
  if (typeof senses !== 'string') return {};
  const out = {};
  for (const part of senses.split(',')) {
    const m = part.trim().match(/^(darkvision|blindsight|tremorsense|truesight)\s+(\d+)/i);
    if (m) out[m[1].toLowerCase()] = Number(m[2]);
  }
  return Object.keys(out).length ? { ...out, units: 'ft' } : {};
}

// dnd5e stores known languages as keys and anything else as free text. A stat
// block that reads "any two languages" is not a language — writing it into
// `value` invents a key Foundry cannot resolve, and the entry renders blank.
export const LANGUAGE_KEYS = new Set([
  'common',
  'dwarvish',
  'elvish',
  'giant',
  'gnomish',
  'goblin',
  'halfling',
  'orc',
  'abyssal',
  'celestial',
  'draconic',
  'deep',
  'infernal',
  'primordial',
  'sylvan',
  'undercommon',
  'aquan',
  'auran',
  'ignan',
  'terran',
  'druidic',
  'cant',
]);

/**
 * "Abyssal, Common"   -> { value: ['abyssal', 'common'], custom: '' }
 * "any two languages" -> { value: [], custom: 'any two languages' }
 */
export function parseLanguages(languages) {
  if (typeof languages !== 'string') return { value: [], custom: '' };
  const value = [];
  const custom = [];
  for (const raw of languages.split(',')) {
    const part = raw.trim();
    if (!part || part === '—' || part === '-' || /^none$/i.test(part)) continue;
    const key = part.toLowerCase().replace(/^thieves'? cant$/, 'cant');
    if (LANGUAGE_KEYS.has(key)) value.push(key);
    else custom.push(part);
  }
  return { value, custom: custom.join(', ') };
}

/** Normalise a Fantasy Statblocks name/value list into [[name, value], ...]. */
function pairs(list) {
  if (!list) return [];
  if (Array.isArray(list)) {
    return list.flatMap(item =>
      typeof item === 'object' && item !== null ? Object.entries(item) : [],
    );
  }
  return Object.entries(list);
}

/** traits/actions -> the biography HTML the existing actors already use. */
export function biographyHtml(fence, extra = '') {
  const section = (heading, entries) => {
    if (!entries?.length) return '';
    const body = entries.map(e => `<p><strong>${e.name}.</strong> ${e.desc ?? ''}</p>`).join('');
    return `<h3>${heading}</h3>${body}`;
  };
  return [
    extra,
    section('Traits', fence.traits),
    section('Actions', fence.actions),
    section('Reactions', fence.reactions),
  ]
    .filter(Boolean)
    .join('');
}

/**
 * Compile a parsed fence into a dnd5e actor document.
 *
 * `name` is the actor's name (the note's title); the fence's own `name:` is the
 * card's display name and may differ.
 */
export function toActor(fence, { name, disposition = -1, biographyIntro = '', img } = {}) {
  const warnings = [];
  const cr = parseCR(fence.cr ?? 0);
  const pb = profBonus(cr);

  const abilities = {};
  const stats = Array.isArray(fence.stats) ? fence.stats : [];
  ABILITIES.forEach((k, i) => {
    abilities[k] = { value: Number(stats[i] ?? 10) };
  });

  const skills = {};
  for (const [label, stated] of pairs(fence.skillsaves)) {
    const key = SKILL_KEYS[String(label).toLowerCase()];
    if (!key) {
      warnings.push(`unknown skill "${label}" — dropped`);
      continue;
    }
    const abilityFor = {
      acr: 'dex',
      ani: 'wis',
      arc: 'int',
      ath: 'str',
      dec: 'cha',
      his: 'int',
      ins: 'wis',
      itm: 'cha',
      inv: 'int',
      med: 'wis',
      nat: 'int',
      prc: 'wis',
      prf: 'cha',
      per: 'cha',
      rel: 'int',
      slt: 'dex',
      ste: 'dex',
      sur: 'wis',
    }[key];
    const { value, flat, note } = skillProficiency(
      stated,
      abilityMod(abilities[abilityFor].value),
      pb,
    );
    skills[key] = flat ? { value, bonuses: { check: String(flat) } } : { value };
    if (note) warnings.push(`skill ${label}: ${note}`);
  }

  const saves = {};
  for (const [label, stated] of pairs(fence.saves)) {
    const key = ABILITY_KEYS[String(label).toLowerCase()] ?? String(label).toLowerCase();
    if (!ABILITIES.includes(key)) {
      warnings.push(`unknown save "${label}" — dropped`);
      continue;
    }
    const { value, note } = skillProficiency(stated, abilityMod(abilities[key].value), pb);
    saves[key] = value;
    if (note) warnings.push(`save ${label}: ${note}`);
  }
  for (const [k, v] of Object.entries(saves)) abilities[k].proficient = v;

  // A blank silhouette is the single most visible way this pipeline can ship
  // something wrong: it looks fine in the JSON and looks broken on the map. The
  // fallback stays (an actor must have SOME img), but it is never silent.
  if (!img) {
    warnings.push(
      `no art — falling back to ${PLACEHOLDER_IMG}. Named NPCs need an \`image:\` ` +
        "pointing at your own file in the game's Assets/Tokens/ " +
        '(or `art_required: false` to accept a generic stand-in).',
    );
  }

  const hp = Number(fence.hp ?? 0);
  const actor = {
    name,
    type: 'npc',
    img: img ?? PLACEHOLDER_IMG,
    items: [],
    prototypeToken: {
      name,
      actorLink: false,
      displayName: 20,
      disposition,
      // The placeholder lands on the token too — without it the sheet showed
      // the silhouette while the map showed nothing at all.
      texture: { src: img ?? PLACEHOLDER_IMG },
    },
    system: {
      abilities,
      attributes: {
        ac: { calc: 'flat', flat: Number(fence.ac ?? 10) },
        hp: { value: hp, max: hp, ...(fence.hit_dice ? { formula: String(fence.hit_dice) } : {}) },
        movement: parseSpeed(fence.speed),
        senses: parseSenses(fence.senses),
      },
      details: {
        alignment: fence.alignment ?? '',
        cr,
        type: { value: String(fence.type ?? 'humanoid').toLowerCase() },
        biography: { value: biographyHtml(fence, biographyIntro) },
      },
      traits: {
        size: SIZES[String(fence.size ?? 'medium').toLowerCase()] ?? 'med',
        languages: parseLanguages(fence.languages),
      },
      ...(Object.keys(skills).length ? { skills } : {}),
    },
  };
  return { actor, warnings };
}

/**
 * Diff a fence against the SRD record it cites.
 *
 * Divergence is EXPECTED — a named NPC built on a Spy is meant to differ — so
 * every difference is reported as a delta for a human to look at, never as an
 * error. `deviations: [hp, ac]` in the fence silences the ones that are on
 * purpose, which keeps intentional changes visible in review instead of
 * invisible. `exact: true` turns any remaining delta into an error.
 */
export function verify(fence, srd) {
  const deltas = [];
  if (!srd) return deltas;
  const deviations = new Set((fence.deviations ?? []).map(s => String(s).toLowerCase()));

  const cmp = (field, mine, theirs) => {
    if (theirs === undefined || mine === undefined) return;
    if (deviations.has(field)) return;
    if (String(mine) !== String(theirs)) {
      deltas.push({ field, authored: mine, srd: theirs });
    }
  };

  // srd.ac is absent for armour-wearing monsters, where the system derives it
  // from equipment at runtime. Absent means "not checkable", not "AC 0".
  cmp('ac', fence.ac, srd.ac);
  cmp('hp', fence.hp, srd.hp);
  // CR is written as a fraction in stat blocks ("1/8") but numeric in the cache.
  cmp('cr', fence.cr === undefined ? undefined : parseCR(fence.cr), srd.cr);
  cmp('type', String(fence.type ?? '').toLowerCase(), srd.type);
  cmp('size', SIZES[String(fence.size ?? '').toLowerCase()], srd.size);

  const stats = Array.isArray(fence.stats) ? fence.stats : [];
  ABILITIES.forEach((k, i) => cmp(k, stats[i], srd.abilities?.[k]));

  // Skill bonuses, when the reference supplies them as STATED numbers (Open5e
  // does; the dnd5e compendium does not, because it stores a proficiency
  // multiplier and derives the number). Comparing the printed bonus directly
  // catches the same class of error as the expertise derivation in toActor, but
  // from the other side: there we ask "what multiplier yields this bonus?", here
  // "is this the bonus the published creature actually has?".
  if (srd.skills) {
    for (const [label, stated] of pairs(fence.skillsaves)) {
      const key = SKILL_KEYS[String(label).toLowerCase()];
      if (!key) continue; // already warned about during compilation
      cmp(`skill.${label}`, Number(stated), srd.skills[key]);
    }
  }

  return deltas;
}

export function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--srd') opts.srd = argv[++i];
    else if (a === '--disposition') opts.disposition = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else rest.push(a);
  }
  if (!rest.length) throw new Error('Missing <note.md>');
  opts.note = rest[0];
  return opts;
}

export async function compileNote(notePath, opts = {}) {
  const markdown = await readFile(notePath, 'utf8');
  const fence = parseFence(markdown);
  if (!fence) throw new Error(`${notePath}: no \`\`\`statblock fence found`);

  const frontmatter = parseFrontmatter(markdown);
  const name = path.basename(notePath, path.extname(notePath));
  const { base, edition } = parseSource(fence.source);

  // Two references, deliberately. The dnd5e compendium cache supplies token
  // ART (Open5e ships none), and Open5e supplies the authoritative STATS —
  // including a numeric AC for armour-wearing creatures, which the compendium
  // derives at runtime and therefore cannot provide.
  let art;
  const srdPath = opts.srd ?? srdFor(edition, opts.reference);
  if (srdPath) {
    try {
      art = JSON.parse(await readFile(srdPath, 'utf8')).creatures?.[base];
    } catch (err) {
      // The cache is optional unless explicitly requested — but a hand-passed
      // --srd that cannot be read is an operator error, not a fallback.
      if (opts.srd) throw err;
    }
  }

  let reference = art;
  const open5ePath = opts.open5e ?? open5eFor(edition, opts.reference);
  if (open5ePath) {
    try {
      const index = JSON.parse(await readFile(open5ePath, 'utf8'));
      // Merge, not replace: keep the compendium's tokenSrc, prefer Open5e's stats.
      if (index.creatures?.[base]) reference = { ...art, ...index.creatures[base] };
    } catch {
      // No cache for this edition — fall back to the compendium alone.
    }
  }

  // Art resolution order: explicit image:, then the creature's real SRD token,
  // then the curated icon map (art-resolve.mjs) — whose silhouette tier only a
  // source:-inherited mook may use. A bespoke named NPC that reaches the map
  // and misses resolves to nothing, and the placeholder warning fires.
  let img = fence.image ?? art?.tokenSrc;
  if (!img) {
    let artMap = {};
    try {
      artMap = JSON.parse(await readFile(opts.artMap ?? DEFAULT_ART_MAP, 'utf8'));
    } catch {
      // No map is a resolvable state: the chain simply ends at `none`.
    }
    img = resolveArt(
      {
        // The note title is the actor's identity; the base is what it was
        // built on. The resolver treats them as a mook only when they agree —
        // "Bandit.md" on Bandit is a bandit, "Amira Granger.md" on Spy is a
        // character whose art gap must stay visible.
        name,
        base,
        type: fence.type,
        art_required: fence.art_required,
      },
      artMap,
    ).src;
  }

  const { actor, warnings } = toActor(fence, {
    name,
    disposition: opts.disposition ?? parseDisposition(frontmatter.disposition),
    img,
  });

  return {
    actor,
    warnings,
    deltas: verify(fence, reference),
    base,
    edition,
    exact: fence.exact === true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { actor, warnings, deltas, base, exact } = await compileNote(opts.note, opts);

  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const d of deltas) {
    console.warn(`delta vs SRD ${base}: ${d.field} authored ${d.authored}, SRD ${d.srd}`);
  }
  if (deltas.length && exact) {
    throw new Error(
      `${opts.note}: exact: true, but ${deltas.length} field(s) diverge from SRD ${base}`,
    );
  }

  const json = `${JSON.stringify(actor, null, 2)}\n`;
  if (opts.out) {
    await writeFile(opts.out, json);
    console.log(`Wrote ${opts.out}`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
