#!/usr/bin/env node
// Read everything on a character sheet that is not a number, so a pregen
// imported into Foundry arrives with the things it owns rather than a bare
// stat block.
//
// The numbers half already worked: pool-from-sheets.mjs reads ability scores,
// skill ticks, AC and hit points, and derives the rest. That produces an actor
// with two Items on it. A finished dnd5e character carries around forty-seven —
// the Starter Heroes' Akra has a class, a subclass, a species, a background,
// five feats, eighteen spells, weapons, armour, packs and coins — and every one
// of those is something the sheet already lists.
//
// So this module reads the lists. It maps nothing onto Foundry: what a name
// means in a compendium is a separate, curated decision, because guessing it is
// how a character ends up carrying the wrong sword.
//
// The export's field naming is irregular in ways that look like typos and are
// not, and this is why nothing here retypes a field name. Measured across the
// five pool sheets:
//
//   Wpn Name      Wpn Name 2    Wpn Name 3     — the first has no number
//   Wpn1 AtkBonus 'Wpn2 AtkBonus ' 'Wpn3 AtkBonus  ' — none, one, two trailing
//   Wpn Notes 1   Wpn Notes 2                   — and none at all for row 4
//
// Reads are therefore made through the tolerant reader in pool-from-sheets.mjs.
//
// Prose blocks carry their own structure, which is stable across all five:
//
//   === ROGUE FEATURES ===
//   * Sneak Attack • PHB-2024 129
//   Once per turn you can deal an extra 1d6 damage…
//      | Special
//
// A `===` line opens a section, a `*` line opens an entry and names its source
// page, and everything after it is that entry's text until the next one.
import { fieldMap } from './sheet-fields.mjs';
import { fieldReader } from './pool-from-sheets.mjs';

/** How many numbered rows to look for. Beyond this the export stops emitting. */
const MAX_ROWS = 40;

/**
 * Split a `=== HEADING ===` blob into its sections.
 *
 * Returns an ordered array rather than an object: two sections can share a
 * heading, and the order is the order a reader sees on the page.
 */
export function splitSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^\s*===\s*(.+?)\s*===\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections.map(s => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

/**
 * The `* Name • BOOK page` entries in a section, with the prose under each.
 *
 * The bullet is `*` and the separator is a real bullet character, not an
 * asterisk pair — both come straight from the export.
 */
export function parseEntries(text) {
  const entries = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const entry = /^\s*\*\s*(.+?)\s*(?:•\s*(\S+)\s*(\d+)?\s*)?$/.exec(line);
    if (entry && line.trim().startsWith('*')) {
      current = {
        name: entry[1].trim(),
        source: entry[2] ?? null,
        page: entry[3] ? Number(entry[3]) : null,
        lines: [],
      };
      entries.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return entries.map(e => ({
    name: e.name,
    source: e.source,
    page: e.page,
    text: e.lines.join('\n').trim(),
  }));
}

/** A comma-separated list, trimmed, with the empties dropped. */
export function commaList(text) {
  return String(text ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * Armour, weapon and tool proficiencies plus languages.
 *
 * One field on the sheet holds all four, sectioned. A heading the export does
 * not print simply yields an empty list, which is the truth: the wizard is
 * proficient with no armour at all.
 */
export function proficienciesFromSheet(at) {
  const sections = splitSections(at('ProficienciesLang'));
  const of = name => {
    const found = sections.find(s => s.heading.toUpperCase() === name);
    return found ? commaList(found.text) : [];
  };
  return {
    armor: of('ARMOR'),
    weapons: of('WEAPONS'),
    tools: of('TOOLS'),
    languages: of('LANGUAGES'),
  };
}

/** Carried equipment, in the order the sheet lists it. */
export function equipmentFromSheet(at) {
  const items = [];
  for (let i = 0; i < MAX_ROWS; i++) {
    const name = (at(`Eq Name${i}`) ?? '').trim();
    if (!name) continue;
    const quantity = Number(at(`Eq Qty${i}`)) || 1;
    items.push({ name, quantity, weight: (at(`Eq Weight${i}`) ?? '').trim() || null });
  }
  return items;
}

/**
 * The attack rows.
 *
 * The first row's fields carry no number, and the numbered ones carry varying
 * trailing whitespace, so every read goes through the tolerant reader.
 */
export function weaponsFromSheet(at) {
  const weapons = [];
  for (let row = 1; row <= 6; row++) {
    const name = (at(row === 1 ? 'Wpn Name' : `Wpn Name ${row}`) ?? '').trim();
    if (!name) continue;
    weapons.push({
      name,
      attackBonus: (at(`Wpn${row} AtkBonus`) ?? '').trim() || null,
      damage: (at(`Wpn${row} Damage`) ?? '').trim() || null,
      // The mastery property a 2024 character chose shows up here and nowhere
      // else — `Martial, Heavy, Two-Handed, Graze`.
      properties: commaList(at(`Wpn Notes ${row}`)),
    });
  }
  return weapons;
}

/**
 * Spells, grouped by the level heading they sit under.
 *
 * `spellHeader<n>` opens a group and `spellName<i>` runs continuously across
 * all groups, so a spell's level is decided by which header most recently
 * preceded its index rather than by any field on the spell itself.
 */
export function spellsFromSheet(fields, at) {
  const headers = [];
  for (const [name, value] of Object.entries(fields)) {
    const header = /^spellHeader(\d+)$/.exec(name.trim());
    if (!header) continue;
    const level = /CANTRIP/i.test(String(value)) ? 0 : Number(/(\d+)/.exec(String(value))?.[1]);
    headers.push({ group: Number(header[1]), level: Number.isFinite(level) ? level : null });
  }
  headers.sort((a, b) => a.group - b.group);

  // Which spell index each group starts at: groups are numbered in order, and
  // a spell belongs to the last group whose slot header it follows.
  const groupStarts = [];
  for (const { group } of headers) {
    const slots = at(`spellSlotHeader${group}`);
    groupStarts.push({ group, slots: slots ? String(slots).trim() : null });
  }

  const spells = [];
  let group = -1;
  for (let i = 0; i < 200; i++) {
    if (headers.some(h => h.group === group + 1) && spellStartsGroup(fields, i, group + 1)) {
      group += 1;
    }
    const name = (at(`spellName${i}`) ?? '').trim();
    if (!name) continue;
    const level = headers.find(h => h.group === group)?.level ?? null;
    spells.push({
      name: name.replace(/\s*\[R\]\s*$/, ''),
      ritual: /\[R\]\s*$/.test(name),
      level,
      source: (at(`spellSource${i}`) ?? '').trim() || null,
      prepared: (at(`spellPrepared${i}`) ?? '').trim() || null,
    });
  }
  return { spells, groups: groupStarts };
}

/**
 * Whether spell index `i` is the first of group `group`.
 *
 * The export writes headers and spells into one flat sequence, so the boundary
 * is implicit. The first spell after a header belongs to it, and there is no
 * field saying so — this reconstructs it by counting how many spells precede
 * each header in field order.
 */
function spellStartsGroup(fields, i, group) {
  const order = Object.keys(fields);
  const headerAt = order.indexOf(`spellHeader${group}`);
  if (headerAt === -1) return false;
  const spellAt = order.indexOf(`spellName${i}`);
  return spellAt > headerAt;
}

/** Coins, as the sheet counts them. */
export function coinsFromSheet(at) {
  const coins = {};
  for (const key of ['cp', 'sp', 'ep', 'gp', 'pp']) {
    coins[key] = Number(at(key.toUpperCase())) || 0;
  }
  return coins;
}

/**
 * Class features, species traits and feats, kept apart.
 *
 * They are separated because they become different things in Foundry and
 * because a reader wants them separate, but the split is made on the heading
 * the export prints rather than on a list of known names — a heading we have
 * never seen is still classified, and never dropped.
 */
export function featuresFromSheet(at) {
  const blob = [1, 2, 3]
    .map(i => at(`FeaturesTraits${i}`) ?? '')
    .filter(Boolean)
    .join('\n');

  const out = { class: [], species: [], feats: [], other: [] };
  for (const section of splitSections(blob)) {
    const heading = section.heading.toUpperCase();
    const bucket = heading.endsWith('SPECIES TRAITS')
      ? 'species'
      : heading === 'FEATS'
        ? 'feats'
        : heading.endsWith('FEATURES')
          ? 'class'
          : 'other';
    for (const entry of parseEntries(section.text)) out[bucket].push({ ...entry, heading });
  }
  return out;
}

/** Everything on a sheet that is not one of the numbers already derived. */
export function contentFromSheet(bytes) {
  const fields = fieldMap(bytes);
  const at = fieldReader(fields);
  const { spells, groups } = spellsFromSheet(fields, at);

  return {
    size: (at('SIZE') ?? '').trim() || null,
    proficiencies: proficienciesFromSheet(at),
    equipment: equipmentFromSheet(at),
    weapons: weaponsFromSheet(at),
    spells,
    spellGroups: groups,
    coins: coinsFromSheet(at),
    features: featuresFromSheet(at),
  };
}
