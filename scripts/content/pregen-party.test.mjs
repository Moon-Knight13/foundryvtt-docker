import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hookText,
  hooksFor,
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
  await assert.rejects(resolveParty(gameDir, poolDir), /Available: dwarf-cleric, elf-wizard/);
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
