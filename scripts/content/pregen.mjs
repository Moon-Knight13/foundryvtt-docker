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
import { slug } from './handout.mjs';
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

/** Placeholder art, matching statblock.mjs so a pregen fails the same way. */
export const PLACEHOLDER_IMG = 'icons/svg/mystery-man.svg';

/**
 * Turn a derived character into a dnd5e `character` actor.
 *
 * Two decisions here are not cosmetic.
 *
 * **The class Item is mandatory.** dnd5e does not store a character's level; it
 * sums `system.levels` across owned class Items and derives from that. An actor
 * with `items: []` therefore prepares at level 0, which yields a proficiency
 * bonus of +1 and puts every save, skill and attack one or two points below the
 * sheet that was printed from the same source. The wrongness is uniform and
 * plausible, which is the worst kind. So a pregen always carries its class.
 *
 * **Spell slots are written as overrides.** dnd5e can derive slots from a class
 * Item's spellcasting progression, but a hand-built class Item carries no such
 * progression, and a silently empty slot row on a caster is the same failure as
 * above. Writing the slots this pipeline derived — the ones already checked
 * against an independent source and printed on the sheet — makes the actor and
 * the paper agree by construction rather than by coincidence.
 *
 * `ac.calc: 'flat'` for the same reason: the character owns no armour Item, so
 * `default` would derive 10 + Dex and quietly disagree with the printed AC.
 */
export function toCharacterActor(character, { img, biographyHtml = '' } = {}) {
  const warnings = [];

  const abilities = {};
  for (const ability of ABILITIES) {
    abilities[ability] = {
      value: character.abilities[ability].score,
      proficient: character.saves[ability].proficient ? 1 : 0,
    };
  }

  const skills = {};
  for (const [name, skill] of Object.entries(character.skills)) {
    if (skill.multiplier > 0) skills[skill.key] = { value: skill.multiplier };
  }

  const items = [
    {
      name: character.className,
      type: 'class',
      system: {
        identifier: character.classSlug,
        levels: character.level,
        hitDice: `d${character.hitDice.split('d')[1]}`,
        hitDiceUsed: 0,
      },
    },
  ];
  if (character.subclass) {
    items.push({
      name: character.subclass,
      type: 'subclass',
      system: { identifier: slug(character.subclass), classIdentifier: character.classSlug },
    });
  }

  const spells = {};
  if (character.spellcasting) {
    for (const [tier, count] of Object.entries(character.spellcasting.slots ?? {})) {
      spells[`spell${tier}`] = { value: count, override: count };
    }
    if (character.spellcasting.pact) {
      const level = Number(String(character.spellcasting.pact.level).replace(/\D/g, '')) || 1;
      spells.pact = {
        value: character.spellcasting.pact.slots,
        override: character.spellcasting.pact.slots,
        level,
      };
    }
  }

  if (!img) {
    warnings.push(
      `no art — falling back to ${PLACEHOLDER_IMG}. A pregen can pass the strict ` +
        'art gate with a generic class token; point `image:` at one in the pool.',
    );
  }
  if (character.ac === null) {
    warnings.push('no `ac:` — a pregen handed to a player needs one, since nothing derives it.');
  }

  const actor = {
    name: character.name,
    type: 'character',
    img: img ?? PLACEHOLDER_IMG,
    items,
    prototypeToken: {
      name: character.name,
      // Unlike an NPC, a player character's token is linked: damage taken on
      // the map is damage to the sheet the player is holding.
      actorLink: true,
      displayName: 30,
      disposition: 1,
      texture: { src: img ?? PLACEHOLDER_IMG },
    },
    system: {
      abilities,
      attributes: {
        ac: { calc: 'flat', flat: character.ac ?? 10 },
        hp: { value: character.hitPoints.max, max: character.hitPoints.max },
        movement: { walk: character.speed ?? 30, units: 'ft' },
        ...(character.spellcasting ? { spellcasting: character.spellcasting.ability } : {}),
      },
      details: {
        // Strings rather than Item links. Which one dnd5e 5.3.3 wants is one of
        // the checks that needs a real Foundry; a string at least renders.
        race: character.species ?? '',
        background: character.background ?? '',
        biography: { value: biographyHtml },
        xp: { value: 0 },
      },
      traits: { size: 'med' },
      ...(Object.keys(skills).length ? { skills } : {}),
      ...(Object.keys(spells).length ? { spells } : {}),
    },
  };

  return { actor, warnings };
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

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/**
 * The biography a player reads on the actor sheet.
 *
 * Deliberately the same prose the printed sheet carries, so the two surfaces
 * say one thing. Game-specific hooks append here rather than replacing it,
 * which is what keeps a pool pregen playable with every hook stripped out.
 */
export function biographyHtml(character, hooks = []) {
  const line = [
    character.species,
    `${character.className}${character.subclass ? ` (${character.subclass})` : ''}`,
    `level ${character.level}`,
  ]
    .filter(Boolean)
    .join(' — ');

  const parts = [`<p><strong>${escapeHtml(line)}</strong></p>`];
  if (character.background) parts.push(`<p>Background: ${escapeHtml(character.background)}</p>`);
  if (character.features.length) {
    parts.push(
      `<p><strong>Features</strong></p><ul>${character.features
        .map(f => `<li>${escapeHtml(f)}</li>`)
        .join('')}</ul>`,
    );
  }
  for (const hook of hooks) {
    parts.push(`<p><em>${escapeHtml(hook)}</em></p>`);
  }
  return parts.join('');
}

/**
 * Compile one pregen note into a character actor.
 *
 * Mirrors statblock.mjs's compileNote so compile-game.mjs treats the two the
 * same way: read the note, derive, hand back the actor plus anything a person
 * should look at.
 */
export async function compilePregen(notePath, opts = {}) {
  const markdown = await readFile(notePath, 'utf8');
  const spec = parseFence(markdown);
  if (!spec) throw new Error('no ```pregen fence');

  const progression =
    opts.progression ?? (await loadProgression(spec.edition ?? '2014', opts.reference));
  const named = { ...spec, name: spec.name ?? path.basename(notePath, '.md') };
  const character = derive(named, progression);
  const hooks = Array.isArray(opts.hooks) ? opts.hooks : [];
  const { actor, warnings } = toCharacterActor(character, {
    img: spec.image,
    biographyHtml: biographyHtml(character, hooks),
  });
  return { character, actor, warnings, hooks };
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
