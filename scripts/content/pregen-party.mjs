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
import { readdir, readFile } from 'node:fs/promises';
import { parseFrontmatter, slug } from './handout.mjs';
import { parseFence } from './pregen.mjs';

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

/** Every pregen note in the pool, keyed by slug. */
export async function readPool(poolDir) {
  const pool = new Map();
  let files;
  try {
    files = await readdir(poolDir);
  } catch {
    throw new Error(
      `No pregen pool at ${poolDir}. It holds the shared characters a game draws from.`,
    );
  }
  for (const file of files.filter(f => f.endsWith('.md')).sort()) {
    const notePath = path.join(poolDir, file);
    const markdown = await readFile(notePath, 'utf8');
    if (!/```pregen/.test(markdown)) continue; // An index or prose note.
    const spec = parseFence(markdown);
    pool.set(slug(path.basename(file, '.md')), { note: notePath, spec, name: spec?.name ?? null });
  }
  return pool;
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
export function validateParty(party, pool) {
  const problems = [];

  const drawn = [];
  for (const name of party.party) {
    const entry = pool.get(name);
    if (!entry) {
      problems.push(`"${name}" is not in the pool. Available: ${[...pool.keys()].join(', ')}`);
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
export async function resolveParty(gameDir, poolDir) {
  const party = await readParty(gameDir);
  if (!party) return null;

  const pool = await readPool(poolDir);
  const { drawn, problems } = validateParty(party, pool);
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
