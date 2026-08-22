#!/usr/bin/env node
// Build a committed reference index of class progression — the level-by-level
// tables — so a pregen at any level can be derived instead of typed.
//
// This is the third reference cache, and the three answer different questions:
//
//   srd-cache.mjs     (dnd5e compendium)  "will this render in MY Foundry?"
//   open5e-cache.mjs  (published creature) "is this faithful to the MONSTER?"
//   pregen-cache.mjs  (this file)          "what does a level-7 bard HAVE?"
//
// The point of it is error removal. Issue #115 exists because pregens were
// going to be written by hand, and a hand-typed proficiency bonus or spell-slot
// row is exactly the mistake nobody catches until it is on a player's sheet at
// the table. Nothing in a class table should ever be retyped.
//
// Both editions come from one source with one shape, so supporting 2014 and
// 2024 costs a parameter rather than a second pipeline:
//
//   srd-2014  SRD 5.1, CC-BY-4.0
//   srd-2024  SRD 5.2, CC-BY-4.0
//
// Three files per edition, and the join between them is why no slug ever has to
// be parsed out of a string:
//
//   CharacterClass.json    12 classes + 12 subclasses. `subclass_of` says which.
//   ClassFeature.json      every feature, with `parent` naming its owner.
//   ClassFeatureItem.json  one row per (feature, level), with the table cell.
//
// A ClassFeatureItem's `parent` is a ClassFeature pk, and that feature's
// `parent` is a CharacterClass pk. Every row resolves — verified, 0 unresolved
// in both editions — so ownership is followed, never inferred. This matters:
// `srd_barbarian_primal-champion` contains the subclass slug `champion` and is
// a barbarian class feature, so any substring match on these names is wrong.
//
// Two edition asymmetries this has to absorb:
//
//   * 2014 leaves `caster_type` null on all but one class, while 2024 fills it
//     in. So caster type is DERIVED from the shape of the slot tracks, and the
//     declared value is used only to check the derivation.
//   * The columns are not the same set. 2014 has `cantrips-known` and
//     `spells-known`; 2024 has `cantrips` and `prepared-spells`. Rather than
//     hardcode a list that will rot, every numeric column is kept under the
//     name the table gives it.
//
// What is cached is names and numbers — never feature descriptions. The repo
// ships under the terms enumerated in content/reference/LICENSE.md and is not a
// redistribution channel for SRD prose.
//
// Usage:
//   node scripts/content/pregen-cache.mjs [--out <dir>] [--edition 2014|2024]
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const RAW = 'https://raw.githubusercontent.com/open5e/open5e-api/main/data/v2/wizards-of-the-coast';

/** Matches open5e-cache.mjs, so a note's `source:` line picks the same index. */
export const EDITIONS = [
  { key: '2014', srd: '5.1', dir: 'srd-2014', out: 'progression-2014.json' },
  { key: '2024', srd: '5.2', dir: 'srd-2024', out: 'progression-2024.json' },
];

/** The three files the join needs. */
export const SOURCE_FILES = ['CharacterClass', 'ClassFeature', 'ClassFeatureItem'];

/** Levels a class table covers. Nothing here caps a pregen below 20. */
export const MAX_LEVEL = 20;

/**
 * Strip the document prefix off a pk.
 *
 * `srd_wizard` and `srd-2024_wizard` both mean wizard, and the prefix is the
 * only part that moves between editions. The prefix never contains an
 * underscore, so the first one is the boundary.
 */
export function slug(pk) {
  const cut = String(pk ?? '').indexOf('_');
  return cut === -1 ? String(pk ?? '') : pk.slice(cut + 1);
}

/** `D12` to 12. The die is the only part of the string that carries meaning. */
export function hitDie(value) {
  const match = /^d?(\d+)$/i.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** `+3` to 3, `4` to 4, `1d6` and `1st` to null — those stay as printed. */
export function numeric(value) {
  if (value === null || value === undefined) return null;
  const match = /^([+-]?\d+)$/.exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

/**
 * Which spell-slot shape a class has, read off its table rather than its
 * metadata.
 *
 * Derived because 2014 declares `caster_type: null` for eleven of its twelve
 * classes. Trusting that field would make every 2014 caster look like a
 * non-caster, and the failure would show up as a pregen with no spell slots
 * rather than as an error.
 */
export function casterType(trackNames) {
  const names = new Set(trackNames);
  if (names.has('spell-slots') && names.has('slot-level')) return 'pact';
  const tiers = [...names]
    .map(n => /^slots-(\d)/.exec(n))
    .filter(Boolean)
    .map(m => Number(m[1]));
  if (tiers.length === 0) return 'none';
  return Math.max(...tiers) >= 6 ? 'full' : 'half';
}

/** Open5e's declared value, in this module's vocabulary. Null when unstated. */
function declaredCasterType(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).toLowerCase();
  return key === 'none' || key === 'full' || key === 'half' || key === 'pact' ? key : null;
}

/**
 * Collapse one feature's level rows into level -> value, resolving the places
 * where the source has two rows for one level.
 *
 * Upstream really does carry these, and left alone they put wrong numbers on a
 * player's sheet — the exact failure #115 exists to prevent. Measured
 * 2026-08-22, there are three shapes and no others:
 *
 *   * Two identical values. `fighter_weapon-mastery-count` has `3` twice at
 *     level 1. Nothing to decide; collapse it.
 *   * A blank and a value. `monk_unarmored-movement` has `[null, "+10 ft."]` at
 *     level 2 because the blank level-1 cell is mislabelled. Take the value.
 *   * Two different values with nothing at the level below. All five 2014 full
 *     casters have `slots-2nd` = `["2", "3"]` at level 4 and no level 3, so the
 *     first value is a level-3 row wearing the wrong label. dnd5eapi.co, an
 *     independent source for the same tables, agrees: 2 slots at level 3 and 3
 *     at level 4.
 *
 * Anything else throws. An unrecognised collision means this reasoning has
 * stopped holding, and guessing at that point is how a wrong table ships.
 * Repairs are returned, not swallowed — they end up in the emitted file.
 */
export function reconcileRows(featurePk, rows) {
  const byLevel = new Map();
  for (const { level, value } of rows) {
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(value);
  }

  const values = new Map();
  const repairs = [];

  for (const [level, found] of [...byLevel].sort((a, b) => a[0] - b[0])) {
    if (found.length === 1) {
      values.set(level, found[0]);
      continue;
    }

    const distinct = [...new Set(found)];
    if (distinct.length === 1) {
      values.set(level, distinct[0]);
      continue;
    }

    const stated = distinct.filter(v => v !== null && v !== undefined);
    if (stated.length === 1) {
      values.set(level, stated[0]);
      repairs.push(`${featurePk} L${level}: dropped a blank duplicate`);
      continue;
    }

    const shiftable = found.length === 2 && level > 1 && !byLevel.has(level - 1);
    const [first, second] = found;
    const ascending =
      numeric(first) === null || numeric(second) === null || numeric(first) <= numeric(second);
    if (shiftable && ascending) {
      values.set(level - 1, first);
      values.set(level, second);
      repairs.push(
        `${featurePk}: "${first}" moved from L${level} to L${level - 1}, which had no row`,
      );
      continue;
    }

    throw new Error(
      `${featurePk} L${level}: ${found.length} values (${found.map(v => JSON.stringify(v)).join(', ')}) ` +
        'and no rule covers this shape. Refusing to guess at a class table.',
    );
  }

  return { values, repairs };
}

/**
 * Reduce the three Open5e files to one progression index.
 *
 * Rows arrive as Django fixtures — `{pk, model, fields}` — and this returns
 * plain data keyed by slug, sorted, so a rebuild produces a diffable file.
 */
export function distillProgression({ characterClasses, classFeatures, classFeatureItems }) {
  const classesByPk = new Map();
  for (const row of characterClasses) classesByPk.set(row.pk, row.fields);

  const featuresByPk = new Map();
  for (const row of classFeatures) featuresByPk.set(row.pk, row.fields);

  // One pass over the level rows, grouped by the feature that owns them.
  const rowsByFeature = new Map();
  for (const row of classFeatureItems) {
    const { parent, level, column_value: columnValue } = row.fields;
    if (!rowsByFeature.has(parent)) rowsByFeature.set(parent, []);
    rowsByFeature.get(parent).push({ level, value: columnValue });
  }

  // Blank per class and subclass, so a class with no table still comes out
  // shaped like the others.
  const owners = new Map();
  for (const [pk, fields] of classesByPk) {
    owners.set(pk, {
      pk,
      slug: slug(pk),
      name: fields.name,
      subclassOf: fields.subclass_of ? slug(fields.subclass_of) : null,
      declaredCaster: declaredCasterType(fields.caster_type),
      hitDie: hitDie(fields.hit_dice),
      saves: [...(fields.saving_throws ?? [])].sort(),
      trackNames: new Set(),
      levels: new Map(),
    });
  }

  const levelOf = (owner, level) => {
    if (!owner.levels.has(level)) {
      owner.levels.set(level, { features: [], tracks: {} });
    }
    return owner.levels.get(level);
  };

  const repairs = [];

  for (const [featurePk, rows] of rowsByFeature) {
    const feature = featuresByPk.get(featurePk);
    if (!feature) continue; // no owner to attribute it to
    const owner = owners.get(feature.parent);
    if (!owner) continue;

    const reconciled = reconcileRows(featurePk, rows);
    repairs.push(...reconciled.repairs);

    // A feature whose rows carry table cells IS a column, not a thing gained at
    // a level. One column in 2024 — the monk's Unarmored Movement — has a blank
    // cell at level 1, so "every row valued" would misclassify it and emit
    // twenty phantom feature gains. Any valued row is enough.
    const isTrack = [...reconciled.values.values()].some(v => v !== null && v !== undefined);
    const name = slug(featurePk).slice(slug(owner.pk).length + 1) || slug(featurePk);

    for (const [level, value] of reconciled.values) {
      if (isTrack) {
        if (value !== null && value !== undefined) levelOf(owner, level).tracks[name] = value;
      } else {
        levelOf(owner, level).features.push(feature.name);
      }
    }
    if (isTrack) owner.trackNames.add(name);
  }

  // Assemble, checking the derivation against what the source claims.
  const out = {};
  for (const owner of owners.values()) {
    if (owner.subclassOf) continue;

    const derived = casterType(owner.trackNames);
    if (owner.declaredCaster && owner.declaredCaster !== derived) {
      throw new Error(
        `${owner.slug}: table says "${derived}" caster, Open5e says "${owner.declaredCaster}". ` +
          'One of them is wrong, and a pregen built on the wrong one gets the whole spell list wrong.',
      );
    }

    const subclasses = {};
    for (const other of owners.values()) {
      if (other.subclassOf !== owner.slug) continue;
      subclasses[other.slug] = { name: other.name, levels: levelIndex(other) };
    }

    out[owner.slug] = {
      name: owner.name,
      hitDie: owner.hitDie,
      saves: owner.saves,
      casterType: derived,
      subclasses: sortKeys(subclasses),
      levels: levelIndex(owner),
    };
  }
  return { classes: sortKeys(out), repairs: repairs.sort() };
}

/**
 * One entry per level the class actually has something at, with the slot
 * columns lifted out of the generic table.
 *
 * Slots are broken out because they are structural — a sheet has nine slot
 * boxes and a pact box — while everything else (sneak attack, rages, bardic
 * die, ki) differs per class and is kept under the column's own name.
 */
function levelIndex(owner) {
  const out = {};
  for (let level = 1; level <= MAX_LEVEL; level += 1) {
    const entry = owner.levels.get(level);
    if (!entry) continue;

    const tracks = { ...entry.tracks };
    const record = {};

    const profBonus = numeric(tracks['proficiency-bonus']);
    if (profBonus !== null) record.profBonus = profBonus;
    delete tracks['proficiency-bonus'];

    const slots = {};
    for (const [name, value] of Object.entries(tracks)) {
      const tier = /^slots-(\d)/.exec(name);
      if (!tier) continue;
      const count = numeric(value);
      if (count !== null && count > 0) slots[tier[1]] = count;
      delete tracks[name];
    }
    if (Object.keys(slots).length) record.slots = slots;

    // Pact magic is one row of slots at one level, not a nine-tier table.
    const pactSlots = numeric(tracks['spell-slots']);
    if (pactSlots !== null && tracks['slot-level'] !== undefined) {
      record.pact = { slots: pactSlots, level: tracks['slot-level'] };
      delete tracks['spell-slots'];
      delete tracks['slot-level'];
    }

    if (entry.features.length) record.features = [...entry.features].sort();
    if (Object.keys(tracks).length) record.tracks = sortKeys(tracks);
    if (Object.keys(record).length) out[level] = record;
  }
  return out;
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

export function sourceUrl(dir, file) {
  return `${RAW}/${dir}/${file}.json`;
}

export async function fetchSource(dir, file, fetchImpl = fetch) {
  const url = sourceUrl(dir, file);
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `${url} returned ${res.status}. GitHub is normally reachable from here; ` +
        'if this is a connection failure rather than a 404, check egress.',
    );
  }
  return res.json();
}

/** Fetch one edition's three files and reduce them. */
export async function buildEdition(dir, fetchImpl = fetch) {
  const [characterClasses, classFeatures, classFeatureItems] = await Promise.all(
    SOURCE_FILES.map(file => fetchSource(dir, file, fetchImpl)),
  );
  return distillProgression({ characterClasses, classFeatures, classFeatureItems });
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
    const { classes, repairs } = await buildEdition(edition.dir);
    const dest = path.join(opts.out, edition.out);
    await writeFile(
      dest,
      `${JSON.stringify(
        {
          edition: edition.key,
          srd: edition.srd,
          source: `open5e-api/data/v2/wizards-of-the-coast/${edition.dir}`,
          licence: 'CC-BY-4.0',
          // Kept in the file, not just printed: a reader deciding whether to
          // trust a slot count deserves to see where the source needed fixing.
          repairs,
          classes,
        },
        null,
        2,
      )}\n`,
    );
    const casters = Object.values(classes).filter(c => c.casterType !== 'none').length;
    console.log(
      `${dest}: ${Object.keys(classes).length} classes, ${casters} casters (SRD ${edition.srd})`,
    );
    for (const repair of repairs) console.log(`  repaired: ${repair}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
