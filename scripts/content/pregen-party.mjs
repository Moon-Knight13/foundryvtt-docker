#!/usr/bin/env node
// Draw a game's party out of the shared pregen pool and attach that game's
// hooks to them, so a game ships the handful of characters it actually needs
// rather than the whole pool.
//
// A pregen exists at two stages, and the split is what keeps the pool reusable
// while letting a game feel bespoke:
//
//   Pool pregen   a generic chassis — class, level, species, background, and
//                 the numbers derived from them. NO game context at all, so it
//                 is reusable everywhere and cannot carry anything from a
//                 previous run.
//   Game copy     that pregen plus the hooks this game declares, assembled at
//                 compile time into the game's compendium and onto its sheets.
//
// Hooks key off BACKGROUND, never off a character. That is the whole design,
// and it is taken from the table that already exists in the vault at
// "03 Oneshots/Unravelled Plans/GM Run Sheet.md":
//
//   | If someone at the table has… | It fires at… | What happens |
//   | a noble, courtly or disgraced-family name | POI 2 — Logbook | the Guard
//     Captain places the name and tries to have them removed |
//
//   "If nobody has any of these, nothing breaks."
//
// Two properties follow, and both are enforced here rather than left to
// discipline:
//
//   * The game is never reliant on a hook. Hooks are additive prose appended to
//     the biography and the sheet's backstory box; strip every one and the
//     character is still complete and playable.
//   * A hook cannot name a player character. It has no field for one, and a
//     hook whose text mentions any pool pregen by name is a build error — the
//     pool is a closed, known list, so this is an exact check rather than a
//     guess.
//
// The party is declared in the game's own Pregens.md frontmatter, matching how
// cue.mjs reads game-level audio out of Soundtrack.md, and matching the index
// note Dragons of Stormwreck Isle already keeps by hand.
//
//   ---
//   type: index
//   edition: '2014'
//   level: 1
//   party: [elf-wizard, dwarf-cleric, halfling-rogue]
//   hooks:
//     - background: Sage
//       at: POI 3 — Riddle
//       what: give them a nudge instead of a roll
//   ---
import path from 'node:path';
import { access, readdir, readFile } from 'node:fs/promises';
import { parseFrontmatter, slug } from './handout.mjs';
import { parseFence } from './pregen.mjs';
import { fieldMap } from './sheet-fields.mjs';
import { contentFromSheet } from './sheet-content.mjs';
import {
  baseSlug,
  editionOfSheet,
  loadAdjustments,
  slugLevel,
  specFromSheet,
} from './pool-from-sheets.mjs';

/** Where a game declares which pregens it draws. */
export const PARTY_NOTE = 'Pregens.md';

/**
 * Read the game's party declaration. Null when the game does not use the pool,
 * which is not an error — a game may keep its own pregens instead.
 */
export async function readParty(gameDir) {
  let markdown;
  try {
    markdown = await readFile(path.join(gameDir, PARTY_NOTE), 'utf8');
  } catch {
    return null;
  }
  const front = parseFrontmatter(markdown) ?? {};
  if (!Array.isArray(front.party) || front.party.length === 0) return null;
  return {
    edition: front.edition ? String(front.edition) : null,
    level: front.level === undefined ? null : Number(front.level),
    party: front.party.map(entry => slug(String(entry))),
    hooks: Array.isArray(front.hooks) ? front.hooks : [],
  };
}

/** Image extensions a pool sheet's art may use, best first. */
const ART_EXTS = ['.webp', '.png', '.jpg', '.jpeg'];

/**
 * The token art sitting beside a pool sheet, as Foundry will see it.
 *
 * Named after the CHARACTER rather than the sheet — `dwarf_cleric.webp` beside
 * `dwarf_cleric_lv1.pdf` — because art does not change when a character gains a
 * level, and making it per-level would mean five copies of the same picture.
 * A file named after the sheet still wins if one exists, for a character that
 * really does look different at level 10.
 *
 * Returns a vault-relative path, which normalizeArtPath turns into the `DnD/`
 * mount Foundry resolves. Without art a pregen falls back to the placeholder
 * and fails the strict art gate, so this is what lets a pool character ship.
 */
export async function artBeside(poolDir, base, { vault } = {}) {
  const stems = [base, base.replace(/_lv\d+$/i, '')];
  for (const stem of [...new Set(stems)]) {
    for (const ext of ART_EXTS) {
      const file = path.join(poolDir, `${stem}${ext}`);
      try {
        await access(file);
      } catch {
        continue;
      }
      // Everything under the vault root is what Foundry sees under DnD/.
      const root = vault ?? poolDir.split(`${path.sep}DnD${path.sep}`)[0];
      const relative = path.relative(root, file);
      return relative.startsWith('..') ? file : relative;
    }
  }
  return null;
}

/**
 * Every character in the pool, keyed by slug.
 *
 * The pool is a folder of D&D Beyond exports. Reading the PDFs directly is the
 * whole point: the sheet is root truth, and a generated note beside it would be
 * a second copy of the same facts that can fall out of step with the first.
 * There is nothing to regenerate and nothing to keep in sync — drop a PDF in
 * and it is in the pool.
 *
 * A hand-written `.md` note still counts, for a pool entry with no export
 * behind it. A note whose slug collides with a sheet is an error rather than a
 * precedence rule: two sources for one character is exactly the drift reading
 * the PDFs avoids.
 */
export async function readPool(poolDir, { reference, vault } = {}) {
  const pool = new Map();
  let files;
  try {
    files = await readdir(poolDir);
  } catch {
    throw new Error(
      `No pregen pool at ${poolDir}. It holds the shared characters a game draws from.`,
    );
  }

  const adjustments = await loadAdjustments(reference);
  const add = (poolSlug, entry) => {
    const already = pool.get(poolSlug);
    if (already) {
      throw new Error(
        `Two sources for "${poolSlug}" in the pool: ${path.basename(already.source)} and ` +
          `${path.basename(entry.source)}. Delete one — a character with two definitions ` +
          'is the drift that reading the sheets directly is meant to avoid.',
      );
    }
    pool.set(poolSlug, entry);
  };

  for (const file of files.filter(f => f.toLowerCase().endsWith('.pdf')).sort()) {
    const sheetPath = path.join(poolDir, file);
    const bytes = await readFile(sheetPath);

    let spec;
    try {
      ({ spec } = specFromSheet(bytes, { edition: editionOfSheet(fieldMap(bytes)) ?? '2014' }));
    } catch (err) {
      // A blank template, or a PDF that is not a character sheet at all. The
      // pool folder holds both, and one unreadable file must not cost the pool.
      continue;
    }

    const base = path.basename(file, path.extname(file));
    const poolSlug = slug(base);
    const entry = adjustments[poolSlug];
    if (entry?.values) spec.adjustments = entry.values;

    const art = await artBeside(poolDir, base, { vault });
    if (art) spec.image = art;

    add(poolSlug, {
      source: sheetPath,
      sheet: sheetPath,
      note: null,
      // Everything the sheet lists beyond the numbers: gear, spells, feats,
      // proficiencies. Without it a pregen imports as a bare stat block.
      content: contentFromSheet(bytes),
      spec,
      name: spec?.name ?? null,
      character: baseSlug(poolSlug),
      level: Number(spec?.level) || null,
    });
  }

  for (const file of files.filter(f => f.endsWith('.md')).sort()) {
    const notePath = path.join(poolDir, file);
    const markdown = await readFile(notePath, 'utf8');
    if (!/```pregen/.test(markdown)) continue; // An index or prose note.
    const spec = parseFence(markdown);
    const poolSlug = slug(path.basename(file, '.md'));
    add(poolSlug, {
      source: notePath,
      sheet: null,
      note: notePath,
      spec,
      name: spec?.name ?? null,
      character: baseSlug(poolSlug),
      level: Number(spec?.level ?? slugLevel(poolSlug)) || null,
    });
  }

  return pool;
}

/**
 * Find the one pool entry a game means: this character, at the level this game
 * runs at.
 *
 * A game names characters, never levels — `party: [dwarf-cleric]` reads the
 * same whether the game runs at 1 or at 5, so raising a game's level does not
 * mean editing its party list. Naming a pool entry outright still works, for a
 * game that wants one specific sheet.
 */
export function findInPool(pool, name, level) {
  const exact = pool.get(name);
  if (exact) return exact;

  const wanted = baseSlug(name);
  const forCharacter = [...pool.values()].filter(entry => entry.character === wanted);
  if (!forCharacter.length) return null;
  if (level === null || level === undefined) return forCharacter[0];
  return forCharacter.find(entry => entry.level === level) ?? null;
}

/**
 * Which of a game's hooks apply to one drawn pregen.
 *
 * Matching is on background, case-insensitively, because a hook is written by a
 * person and "Sage" and "sage" mean the same thing. A hook may name several
 * backgrounds, since one trigger often covers more than one origin.
 */
export function hooksFor(spec, hooks) {
  const background = String(spec?.background ?? '').toLowerCase();
  if (!background) return [];
  return hooks.filter(hook => {
    const wanted = Array.isArray(hook.background) ? hook.background : [hook.background];
    return wanted.some(b => String(b ?? '').toLowerCase() === background);
  });
}

/** A hook as one line of prose, in the order the run sheet reads. */
export function hookText(hook) {
  const where = hook.at ? ` at ${hook.at}` : '';
  return `${hook.what}${where}.`;
}

/**
 * Check a party declaration before anything is built.
 *
 * Each of these is a mistake that would otherwise reach a table: a character
 * drawn at the wrong level, a hook that can never fire, or a hook that names
 * somebody's character from a previous game.
 */
/**
 * What to do about a character the pool does not hold at this level.
 *
 * Nothing in this repo can build one. A pool entry is a D&D Beyond export made
 * by hand, at a level someone chose, and that is the whole point — levelling a
 * character is a pile of choices no class table decides. So the build stops and
 * names the file to go and make.
 */
export function missingFromPool(pool, name, level, poolDir = null) {
  const character = baseSlug(name);
  const levels = [...pool.values()]
    .filter(entry => entry.character === character)
    .map(entry => entry.level)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const held = pool.size ? [...pool.keys()].join(', ') : 'nothing yet';

  if (levels.length && level !== null) {
    return (
      `${character} is in the pool at level ${levels.join(', ')}, but this game runs at ` +
      `level ${level}. Build it at level ${level} in D&D Beyond and export the PDF to ` +
      `${poolDir ?? 'the pool'} as ${character.replace(/-/g, '_')}_lv${level}.pdf.`
    );
  }
  return (
    `"${name}" is not in the pool. Build the character in D&D Beyond and export the PDF ` +
    `to ${poolDir ?? 'the pool'}. Pool holds: ${held}`
  );
}

export function validateParty(party, pool, { poolDir } = {}) {
  const problems = [];

  const drawn = [];
  for (const name of party.party) {
    const entry = findInPool(pool, name, party.level);
    if (!entry) {
      // A pool gap is not a mistake in the party list — it is work that has not
      // been done yet, and the build knows exactly what that work is. Saying so
      // costs nothing and saves the author working it out from "not in the pool".
      problems.push(missingFromPool(pool, name, party.level, poolDir));
      continue;
    }
    drawn.push({ slug: name, ...entry });
  }

  for (const entry of drawn) {
    if (party.level !== null && Number(entry.spec?.level) !== party.level) {
      // The point of drawing from a pool is that everyone arrives at the level
      // the game runs at. One character a level out is a quiet, table-visible bug.
      problems.push(
        `${entry.slug} is level ${entry.spec?.level} but the game runs at level ${party.level}`,
      );
    }
    if (party.edition && String(entry.spec?.edition) !== party.edition) {
      problems.push(`${entry.slug} is ${entry.spec?.edition} but the game is ${party.edition}`);
    }
  }

  const backgrounds = new Set(drawn.map(e => String(e.spec?.background ?? '').toLowerCase()));
  for (const hook of party.hooks) {
    const wanted = Array.isArray(hook.background) ? hook.background : [hook.background];
    if (!wanted.some(Boolean)) {
      problems.push(`a hook has no background — hooks fire off backgrounds, never off characters`);
      continue;
    }
    if (!wanted.some(b => backgrounds.has(String(b ?? '').toLowerCase()))) {
      // Not fatal to the game, but it is certainly not what the author meant.
      problems.push(
        `hook for "${wanted.join(', ')}" can never fire — no drawn pregen has that background ` +
          `(drawn: ${[...backgrounds].filter(Boolean).join(', ') || 'none'})`,
      );
    }
  }

  // Party-agnosticism, checked exactly rather than by guesswork: the pool is a
  // closed list of names, so a hook mentioning one is naming a character.
  const poolNames = [...pool.values()].map(e => e.name).filter(Boolean);
  for (const hook of party.hooks) {
    const text = `${hook.what ?? ''} ${hook.at ?? ''}`;
    for (const name of poolNames) {
      if (text.toLowerCase().includes(name.toLowerCase())) {
        problems.push(
          `a hook names "${name}". Hooks fire off backgrounds so that a game works ` +
            'with whoever turns up; naming a character makes it a gate.',
        );
      }
    }
  }

  return { drawn, problems };
}

/**
 * Resolve a game's party into notes plus the hooks each one carries.
 *
 * Returns the drawn entries with their hook lines attached, ready for
 * compilePregen to fold into the biography and the printed sheet.
 */
export async function resolveParty(gameDir, poolDir, { vault } = {}) {
  const party = await readParty(gameDir);
  if (!party) return null;

  const pool = await readPool(poolDir, { vault });
  const { drawn, problems } = validateParty(party, pool, { poolDir });
  if (problems.length) {
    throw new Error(`${path.join(gameDir, PARTY_NOTE)}:\n  ${problems.join('\n  ')}`);
  }

  return {
    ...party,
    drawn: drawn.map(entry => ({
      ...entry,
      hooks: hooksFor(entry.spec, party.hooks).map(hookText),
    })),
  };
}

/**
 * The game's Pregens.md body, in the format Dragons of Stormwreck Isle already
 * keeps by hand: what each character is, where the sheet is, which token.
 *
 * Generated so the index cannot drift from what was actually built.
 */
export function partyIndexMarkdown(drawn, { game = 'this game' } = {}) {
  const rows = drawn.map(entry => {
    const spec = entry.spec ?? {};
    const who = `${spec.species ?? ''} ${spec.class ?? ''}`.trim();
    return `| ${spec.name ?? entry.slug} | ${who} ${spec.level ?? ''} | \`Pregens/${entry.slug}.pdf\` | ${entry.hooks.length} |`;
  });

  return [
    '# Pregens',
    '',
    `Ready-to-play characters for ${game}. Hand these out; the PDFs carry the full`,
    'stats, gear and spell lists — they are generated, not transcribed here.',
    '',
    '| Character | Who | Sheet | Hooks |',
    '|---|---|---|---|',
    ...rows,
    '',
    '> [!note] GM',
    '> Every hook fires off a **background**, never off a named character, and each',
    '> one is optional colour. If nobody at the table has any of them, nothing',
    '> breaks.',
    '',
  ].join('\n');
}
