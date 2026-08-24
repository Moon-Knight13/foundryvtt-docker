#!/usr/bin/env node
// Turn what a sheet lists into the Items a dnd5e character actually owns.
//
// A pregen used to import as two Items: a class and, sometimes, a subclass.
// Everything else the character had — its armour, its weapons, its spells, the
// feat that makes it playable the way its owner intended — existed only as
// prose in the biography. `Akra (Dragonborn Cleric)` in dnd5e's own Starter
// Heroes pack carries forty-seven.
//
// Two constraints shape every choice below.
//
// The Items are SELF-CONTAINED, built from the sheet's own text rather than
// referenced out of `dnd5e.spells24` and friends. Referencing would be
// richer — real icons, real activities — but `build.mjs` packs through
// `compilePack`, which writes raw documents into LevelDB and runs no document
// lifecycle hook, so nothing hydrates a reference afterwards. Copying the
// compendium's data in instead would mean reading a live Foundry at build time,
// which CI does not have. A self-contained Item is the only kind that survives
// the trip.
//
// And nothing here GUESSES what a name means. A weapon's damage and properties
// are the ones printed beside it on the sheet; a spell's level is the heading it
// sat under. Where the sheet does not say, the field is left empty rather than
// filled with a plausible default — a pregen carrying a subtly wrong sword is
// worse than one carrying an obviously incomplete one.
import { slug } from './handout.mjs';

/** dnd5e's size keys. The sheet prints the word. */
const SIZES = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

/** Weapon properties dnd5e models as flags, keyed by what the sheet calls them. */
const WEAPON_PROPERTIES = {
  ammunition: 'amm',
  finesse: 'fin',
  heavy: 'hea',
  light: 'lgt',
  loading: 'lod',
  reach: 'rch',
  thrown: 'thr',
  'two-handed': 'two',
  versatile: 'ver',
};

/** The 2024 mastery properties, which are a separate axis from the above. */
const MASTERIES = new Set(['cleave', 'graze', 'nick', 'push', 'sap', 'slow', 'topple', 'vex']);

export function sizeKey(word) {
  return (
    SIZES[
      String(word ?? '')
        .trim()
        .toLowerCase()
    ] ?? 'med'
  );
}

/** `2d6+2 Slashing` -> `{ formula: '2d6+2', type: 'slashing' }`. */
export function parseDamage(printed) {
  const match = /^\s*(\S+)\s+(\w+)\s*$/.exec(String(printed ?? ''));
  if (!match) return null;
  return { formula: match[1], type: match[2].toLowerCase() };
}

/**
 * Split an attack row's notes into what dnd5e models and what it does not.
 *
 * `Martial, Heavy, Two-Handed, Graze` is three different kinds of fact: the
 * weapon's category, its properties, and the 2024 mastery its owner chose. The
 * mastery appears nowhere else on the sheet.
 */
export function splitWeaponNotes(notes = []) {
  const properties = [];
  const masteries = [];
  const rest = [];
  for (const note of notes) {
    const key = note.trim().toLowerCase();
    if (WEAPON_PROPERTIES[key]) properties.push(WEAPON_PROPERTIES[key]);
    else if (MASTERIES.has(key)) masteries.push(note.trim());
    else rest.push(note.trim());
  }
  return { properties, masteries, rest };
}

/** Prose the sheet printed, as the HTML a Foundry description wants. */
export function descriptionHtml(text, extra = []) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);
  const lines = [...paragraphs, ...extra.filter(Boolean)];
  if (!lines.length) return '';
  return lines
    .map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('\n');
}

/**
 * A feature, species trait or feat.
 *
 * `type.value` is what dnd5e sorts the character sheet by, so a species trait
 * filed as a class feature shows up in the wrong list even though it carries
 * the right text.
 */
export function featItem(entry, kind) {
  return {
    name: entry.name,
    type: 'feat',
    system: {
      type: { value: kind, subtype: '' },
      description: {
        value: descriptionHtml(entry.text, entry.page ? [`${entry.source} p.${entry.page}`] : []),
      },
      identifier: slug(entry.name),
    },
  };
}

/**
 * An attack row.
 *
 * Equipped, because it is on the sheet's attack table rather than in its
 * backpack — that is what the table means.
 */
export function weaponItem(weapon) {
  const { properties, masteries, rest } = splitWeaponNotes(weapon.properties);
  const damage = parseDamage(weapon.damage);

  return {
    name: weapon.name,
    type: 'weapon',
    system: {
      equipped: true,
      identifier: slug(weapon.name),
      properties,
      ...(masteries.length ? { mastery: masteries[0].toLowerCase() } : {}),
      damage: damage ? { base: { custom: { enabled: true, formula: damage.formula } } } : {},
      description: {
        value: descriptionHtml(
          '',
          [
            weapon.attackBonus ? `Attack ${weapon.attackBonus}` : null,
            weapon.damage ? `Damage ${weapon.damage}` : null,
            masteries.length ? `Mastery: ${masteries.join(', ')}` : null,
            rest.length ? rest.join(', ') : null,
          ].filter(Boolean),
        ),
      },
    },
  };
}

/**
 * A carried item.
 *
 * Typed `loot` rather than guessed at. The sheet says "Chain Mail" and gives a
 * weight; it does not say it is armour, and inferring that from a name is how a
 * character ends up with an armour class the pipeline did not intend. AC comes
 * from the sheet and is written flat, so nothing here needs to know.
 */
export function gearItem(entry) {
  return {
    name: entry.name,
    type: 'loot',
    system: {
      quantity: entry.quantity,
      ...(entry.weight ? { weight: { value: parseFloat(entry.weight) || 0, units: 'lb' } } : {}),
      identifier: slug(entry.name),
    },
  };
}

/** A spell, at the level of the heading it sat under. */
export function spellItem(spell) {
  return {
    name: spell.name,
    type: 'spell',
    system: {
      level: spell.level ?? 0,
      identifier: slug(spell.name),
      preparation: { mode: 'prepared', prepared: true },
      ...(spell.ritual ? { properties: ['ritual'] } : {}),
      description: {
        value: descriptionHtml('', [spell.source ? `From ${spell.source}` : null]),
      },
    },
  };
}

/**
 * Every Item a sheet's content describes, in the order a reader meets them.
 *
 * The class and subclass are NOT here — they come from the derived character
 * rather than the sheet, and toCharacterActor already builds them.
 */
export function itemsFromContent(content, { species, background } = {}) {
  if (!content) return [];
  const items = [];

  if (species) {
    items.push({
      name: species,
      type: 'race',
      system: { identifier: slug(species), type: { value: 'humanoid' } },
    });
  }
  if (background) {
    items.push({ name: background, type: 'background', system: { identifier: slug(background) } });
  }

  for (const entry of content.features?.class ?? []) items.push(featItem(entry, 'class'));
  for (const entry of content.features?.species ?? []) items.push(featItem(entry, 'race'));
  for (const entry of content.features?.feats ?? []) items.push(featItem(entry, 'feat'));
  for (const entry of content.features?.other ?? []) items.push(featItem(entry, 'feat'));

  for (const weapon of content.weapons ?? []) items.push(weaponItem(weapon));
  for (const entry of content.equipment ?? []) items.push(gearItem(entry));
  for (const spell of content.spells ?? []) items.push(spellItem(spell));

  return items;
}

/** Trait and currency fields the sheet fills that dnd5e will not derive. */
export function traitsFromContent(content) {
  if (!content) return {};
  const p = content.proficiencies ?? {};
  return {
    size: sizeKey(content.size),
    languages: { value: [], custom: (p.languages ?? []).join(';') },
    armorProf: { value: [], custom: (p.armor ?? []).join(';') },
    weaponProf: { value: [], custom: (p.weapons ?? []).join(';') },
    toolProf: { value: [], custom: (p.tools ?? []).join(';') },
  };
}
