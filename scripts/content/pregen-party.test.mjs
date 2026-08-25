import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  artBeside,
  findInPool,
  hookText,
  hooksFor,
  missingFromPool,
  partyIndexMarkdown,
  readParty,
  readPool,
  resolveParty,
  validateParty,
} from './pregen-party.mjs';

/** One pool pregen note: a generic chassis with no game context in it. */
function poolNote({ name, cls = 'wizard', level = 1, background = 'Sage', species = 'High Elf' }) {
  return [
    '---',
    'type: pregen',
    '---',
    '',
    '```pregen',
    `name: ${name}`,
    "edition: '2014'",
    `class: ${cls}`,
    `level: ${level}`,
    `species: ${species}`,
    `background: ${background}`,
    'abilities: { str: 10, dex: 15, con: 14, int: 16, wis: 12, cha: 8 }',
    'skills: [Arcana]',
    'ac: 12',
    'speed: 30',
    '```',
    '',
  ].join('\n');
}

async function fixture({ party, hooks = [], pool: entries } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pregen-party-'));
  const poolDir = path.join(root, 'pool');
  const gameDir = path.join(root, 'game');
  await mkdir(poolDir, { recursive: true });
  await mkdir(gameDir, { recursive: true });

  for (const entry of entries ?? [
    { name: 'Elf Wizard', background: 'Sage' },
    { name: 'Dwarf Cleric', cls: 'cleric', background: 'Soldier', species: 'Hill Dwarf' },
  ]) {
    await writeFile(path.join(poolDir, `${entry.name}.md`), poolNote(entry));
  }

  if (party) {
    const front = [
      '---',
      'type: index',
      "edition: '2014'",
      'level: 1',
      `party: [${party.join(', ')}]`,
      ...(hooks.length ? ['hooks:', ...hooks] : []),
      '---',
      '',
      '# Pregens',
      '',
    ].join('\n');
    await writeFile(path.join(gameDir, 'Pregens.md'), front);
  }

  return { root, poolDir, gameDir };
}

test('a game with no party declaration is not an error', async () => {
  // A game may keep its own pregens instead of drawing from the pool.
  const { gameDir } = await fixture();
  assert.equal(await readParty(gameDir), null);
});

test('the pool is every note that carries a pregen fence', async () => {
  const { poolDir } = await fixture();
  await writeFile(path.join(poolDir, 'README.md'), '# Pool\n\nIndex note, not a character.\n');
  const pool = await readPool(poolDir);
  assert.deepEqual([...pool.keys()].sort(), ['dwarf-cleric', 'elf-wizard']);
  assert.equal(pool.get('elf-wizard').name, 'Elf Wizard');
});

test('hooks match on background, whatever the casing', async () => {
  const hooks = [
    { background: 'sage', at: 'the Riddle', what: 'give them a nudge instead of a roll' },
    { background: ['Soldier', 'Criminal'], what: 'the Guard Captain places the name' },
  ];
  assert.equal(hooksFor({ background: 'Sage' }, hooks).length, 1);
  assert.equal(hooksFor({ background: 'Soldier' }, hooks).length, 1);
  assert.equal(hooksFor({ background: 'Acolyte' }, hooks).length, 0);
  assert.equal(hooksFor({}, hooks).length, 0, 'a pregen with no background matches nothing');
});

test('a hook reads as one line, the way the run sheet reads', () => {
  assert.equal(
    hookText({ at: 'POI 3 — Riddle', what: 'give them a nudge instead of a roll' }),
    'give them a nudge instead of a roll at POI 3 — Riddle.',
  );
  assert.equal(
    hookText({ what: 'Skee knows the name and approves' }),
    'Skee knows the name and approves.',
  );
});

test('a party draws the named pregens and nothing else', async () => {
  // The materialisation rule: a game ships the handful it draws, never the pool.
  const { poolDir, gameDir } = await fixture({ party: ['elf-wizard'] });
  const party = await resolveParty(gameDir, poolDir);
  assert.equal(party.drawn.length, 1);
  assert.equal(party.drawn[0].slug, 'elf-wizard');
  assert.equal((await readPool(poolDir)).size, 2, 'the pool still holds both');
});

test('a hook reaches the pregen whose background it names', async () => {
  const { poolDir, gameDir } = await fixture({
    party: ['elf-wizard', 'dwarf-cleric'],
    hooks: [
      '  - background: Sage',
      '    at: the Riddle Door',
      '    what: give them a nudge instead of a roll',
    ],
  });
  const party = await resolveParty(gameDir, poolDir);
  const wizard = party.drawn.find(d => d.slug === 'elf-wizard');
  const cleric = party.drawn.find(d => d.slug === 'dwarf-cleric');
  assert.deepEqual(wizard.hooks, ['give them a nudge instead of a roll at the Riddle Door.']);
  assert.deepEqual(cleric.hooks, [], 'a Soldier is untouched by a Sage hook, and still playable');
});

test('a pregen drawn at the wrong level is refused', async () => {
  // The point of drawing from a pool is that everyone arrives at the level the
  // game runs at. One character a level out is quiet and visible at the table.
  const { poolDir, gameDir } = await fixture({
    party: ['elf-wizard'],
    pool: [{ name: 'Elf Wizard', level: 4 }],
  });
  await assert.rejects(resolveParty(gameDir, poolDir), /level 4 but the game runs at level 1/);
});

test('a pregen from the wrong edition is refused', async () => {
  const { poolDir, gameDir } = await fixture({ party: ['elf-wizard'] });
  await writeFile(
    path.join(poolDir, 'Elf Wizard.md'),
    poolNote({ name: 'Elf Wizard' }).replace("edition: '2014'", "edition: '2024'"),
  );
  await assert.rejects(resolveParty(gameDir, poolDir), /is 2024 but the game is 2014/);
});

test('a party naming somebody who is not in the pool says who is', async () => {
  const { poolDir, gameDir } = await fixture({ party: ['tiefling-bard'] });
  await assert.rejects(resolveParty(gameDir, poolDir), /Pool holds: dwarf-cleric, elf-wizard/);
});

test('a missing character says what to go and make, not just that it is missing', async () => {
  const { poolDir, gameDir } = await fixture({ party: ['tiefling-bard'] });
  await assert.rejects(resolveParty(gameDir, poolDir), /Build the character in D&D Beyond/);
});

test('a character the pool holds at another level names the levels it does hold', () => {
  const pool = new Map([
    ['dwarf-cleric-lv1', { character: 'dwarf-cleric', level: 1, spec: { level: 1 } }],
    ['dwarf-cleric-lv4', { character: 'dwarf-cleric', level: 4, spec: { level: 4 } }],
  ]);
  const message = missingFromPool(pool, 'dwarf-cleric', 7);

  assert.match(message, /in the pool at level 1, 4/);
  assert.match(message, /this game runs at level 7/);
  assert.match(message, /Build it at level 7 in D&D Beyond/);
});

test('a game draws a character by name and gets the level it runs at', () => {
  const pool = new Map([
    ['dwarf-cleric-lv1', { character: 'dwarf-cleric', level: 1, spec: { level: 1 } }],
    ['dwarf-cleric-lv4', { character: 'dwarf-cleric', level: 4, spec: { level: 4 } }],
  ]);

  assert.equal(findInPool(pool, 'dwarf-cleric', 4).level, 4);
  assert.equal(findInPool(pool, 'dwarf-cleric', 1).level, 1);
  assert.equal(findInPool(pool, 'dwarf-cleric', 7), null);
});

test('naming a pool entry outright still works', () => {
  const pool = new Map([
    ['dwarf-cleric-lv4', { character: 'dwarf-cleric', level: 4, spec: { level: 4 } }],
  ]);
  assert.equal(findInPool(pool, 'dwarf-cleric-lv4', 4).level, 4);
});

test('a hook that can never fire is a build error', async () => {
  // It is not fatal to the game, but it is certainly not what the author meant,
  // and it would go unnoticed at the table as "the hook just did not come up".
  const { poolDir, gameDir } = await fixture({
    party: ['elf-wizard'],
    hooks: ['  - background: Criminal', '    what: the fence recognises them'],
  });
  await assert.rejects(resolveParty(gameDir, poolDir), /can never fire/);
});

test('a hook with no background at all is refused', async () => {
  const { poolDir, gameDir } = await fixture({
    party: ['elf-wizard'],
    hooks: ['  - what: something happens to somebody'],
  });
  await assert.rejects(resolveParty(gameDir, poolDir), /hooks fire off backgrounds/);
});

test('a hook naming a character is refused', async () => {
  // #115's third acceptance criterion. The pool is a closed list of names, so
  // this is an exact check rather than a guess: a hook mentioning one of them
  // is naming a character, which turns optional colour into a gate.
  const { poolDir, gameDir } = await fixture({
    party: ['elf-wizard'],
    hooks: ['  - background: Sage', '    what: Dwarf Cleric vouches for them'],
  });
  await assert.rejects(resolveParty(gameDir, poolDir), /names "Dwarf Cleric"/);
});

test('the generated index says what was actually built', () => {
  const markdown = partyIndexMarkdown(
    [
      {
        slug: 'elf-wizard',
        spec: { name: 'Elf Wizard', species: 'High Elf', class: 'wizard', level: 1 },
        hooks: ['a nudge at the Riddle Door.'],
      },
    ],
    { game: 'Unravelled Plans' },
  );
  assert.match(
    markdown,
    /\| Elf Wizard \| High Elf wizard 1 \| `Pregens\/elf-wizard\.pdf` \| 1 \|/,
  );
  assert.match(markdown, /fires off a \*\*background\*\*/);
  assert.match(markdown, /nothing\n> breaks/, 'the party-agnostic promise stays on the page');
});

// --------------------------------------------------------------------------
// The pool is a folder of D&D Beyond exports. Reading them directly is what
// removes the second copy of the same facts — there is no note to regenerate
// and none to fall out of step.
// --------------------------------------------------------------------------

const POOL_DIR = [
  process.env.DND_VAULT_PATH,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'DnD'),
  path.join(os.homedir(), 'DnD'),
]
  .filter(Boolean)
  .map(v => path.join(v, '01 Systems', 'dnd5e', 'Pregens'))
  .find(p => existsSync(path.join(p, 'human_fighter', 'human_fighter_lv1.pdf')));

const poolSkip = POOL_DIR ? false : 'vault not mounted';

test('a PDF is a pool entry with no note beside it', { skip: poolSkip }, async () => {
  const pool = await readPool(POOL_DIR);

  const fighter = pool.get('human-fighter-lv1');
  assert.equal(fighter.name, 'Human Fighter');
  assert.equal(fighter.level, 1);
  assert.equal(fighter.note, null, 'nothing generated, nothing to keep in step');
  assert.match(fighter.sheet, /human_fighter_lv1\.pdf$/);
});

test('the edition is read off the sheet, not configured', { skip: poolSkip }, async () => {
  const pool = await readPool(POOL_DIR);
  assert.equal(pool.get('human-fighter-lv1').spec.edition, '2024');
});

test('a blank template in the pool folder is not a character', { skip: poolSkip }, async () => {
  // The folder holds sheets and, in a subfolder, the publisher blanks. Neither
  // an unreadable PDF nor a subfolder may cost the pool its characters.
  const pool = await readPool(POOL_DIR);
  assert.ok(pool.size >= 5);
  for (const entry of pool.values()) assert.ok(entry.name, 'every entry is a named character');
});

test('curated adjustments reach a pool entry read from its sheet', { skip: poolSkip }, async () => {
  const pool = await readPool(POOL_DIR);
  assert.equal(pool.get('halfling-rogue-lv1').spec.adjustments.initiative, 2);
});

test('two sources for one character is an error, not a precedence rule', async () => {
  const poolDir = await mkdtemp(path.join(tmpdir(), 'pregen-pool-dupe-'));
  await writeFile(path.join(poolDir, 'Elf Wizard.md'), poolNote({ name: 'Elf Wizard' }));
  await writeFile(path.join(poolDir, 'elf wizard.md'), poolNote({ name: 'Elf Wizard' }));

  await assert.rejects(readPool(poolDir), /Two sources for "elf-wizard"/);
});

// --------------------------------------------------------------------------
// Art. Without it a pregen wears the placeholder, and ship-game.sh stops at
// the strict art gate before anything reaches Foundry.
// --------------------------------------------------------------------------

test('art is found by character name, not by sheet name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pregen-art-'));
  await writeFile(path.join(dir, 'dwarf_cleric.webp'), 'img');

  const found = await artBeside(dir, 'dwarf_cleric_lv4', { vault: dir });
  assert.equal(found, 'dwarf_cleric.webp', 'art does not change when a character levels');
});

test('art named after the sheet wins over art named after the character', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pregen-art-'));
  await writeFile(path.join(dir, 'dwarf_cleric.webp'), 'generic');
  await writeFile(path.join(dir, 'dwarf_cleric_lv4.webp'), 'specific');

  assert.equal(await artBeside(dir, 'dwarf_cleric_lv4', { vault: dir }), 'dwarf_cleric_lv4.webp');
});

test('webp is preferred over the format it was converted from', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pregen-art-'));
  await writeFile(path.join(dir, 'elf_wizard.jpeg'), 'before');
  await writeFile(path.join(dir, 'elf_wizard.webp'), 'after');

  assert.equal(await artBeside(dir, 'elf_wizard_lv1', { vault: dir }), 'elf_wizard.webp');
});

test('a sheet with no art beside it gets none, rather than a wrong guess', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pregen-art-'));
  await writeFile(path.join(dir, 'someone_else.webp'), 'img');

  assert.equal(await artBeside(dir, 'dwarf_cleric_lv1', { vault: dir }), null);
});

test('the pool carries its art through to the spec', { skip: poolSkip }, async () => {
  const pool = await readPool(POOL_DIR);
  const cleric = pool.get('dwarf-cleric-lv1');

  assert.match(cleric.spec.image, /dwarf_cleric\/dwarf_cleric\.webp$/);
  assert.ok(cleric.spec.image.startsWith('DnD/'), 'Foundry sees the vault under DnD/');
});
