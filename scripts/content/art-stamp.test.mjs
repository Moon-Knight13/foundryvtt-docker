import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stampFence, stampGame } from './art-stamp.mjs';
import { compileNote } from './statblock.mjs';

const GOBLIN_FENCE =
  '```statblock\nname: Goblin\nsource: "SRD 5.1 (CC-BY-4.0) — Goblin"\ntype: humanoid\nac: 15\nhp: 7\ncr: 0.25\nstats: [8, 14, 10, 10, 8, 8]\n```\n';

const TEST_ART_MAP = {
  byName: { Goblin: { icon: 'caro-asercion/goblin.svg', artist: 'Caro Asercion' } },
  byType: { humanoid: { icon: 'delapouite/person.svg', artist: 'Delapouite' } },
};

test('stampFence inserts a vault-relative image line right after name:', () => {
  const stamped = stampFence(
    `# Goblin\n\n${GOBLIN_FENCE}`,
    '06 Assets/Tokens/generic/caro-asercion/goblin.svg',
  );
  assert.match(
    stamped,
    /name: Goblin\nimage: 06 Assets\/Tokens\/generic\/caro-asercion\/goblin\.svg\nsource:/,
    'image goes on the line after name, vault-relative for Obsidian',
  );
});

test('stampFence refuses a fence that already carries image:', () => {
  const withImage = GOBLIN_FENCE.replace('name: Goblin\n', 'name: Goblin\nimage: DnD/x.webp\n');
  assert.equal(stampFence(withImage, 'anything.svg'), null, 'never overwrite an author line');
});

async function gameWith(notes) {
  const game = await mkdtemp(path.join(tmpdir(), 'art-stamp-'));
  await mkdir(path.join(game, 'NPCs'), { recursive: true });
  for (const [file, body] of Object.entries(notes)) {
    await writeFile(path.join(game, 'NPCs', file), body);
  }
  const mapPath = path.join(game, 'art-map.json');
  await writeFile(mapPath, JSON.stringify(TEST_ART_MAP));
  return { game, mapPath };
}

test('stampGame writes the map pick into a mook note, and the round trip holds', async () => {
  const { game, mapPath } = await gameWith({ 'Goblin.md': `# Goblin\n\n${GOBLIN_FENCE}` });
  const report = await stampGame(game, { artMap: mapPath });
  assert.equal(report.stamped.length, 1);

  const note = path.join(game, 'NPCs', 'Goblin.md');
  const body = await readFile(note, 'utf8');
  assert.match(body, /image: 06 Assets\/Tokens\/generic\/caro-asercion\/goblin\.svg/);

  // Recompiling the stamped note lands on the identical Foundry path the
  // resolver picked — stamping changes what Obsidian shows, not what ships.
  const { actor } = await compileNote(note, { artMap: mapPath });
  assert.equal(actor.img, 'DnD/06 Assets/Tokens/generic/caro-asercion/goblin.svg');
});

test('stampGame never touches named NPCs, explicit lines, or artless notes', async () => {
  const named =
    '```statblock\nname: Amira Granger\nsource: "SRD 5.1 (CC-BY-4.0) — Goblin"\ntype: humanoid\nac: 12\nhp: 27\ncr: 1\nstats: [10, 12, 10, 12, 14, 16]\n```\n';
  const explicit = GOBLIN_FENCE.replace(
    'name: Goblin\n',
    'name: Goblin\nimage: DnD/x/goblin.webp\n',
  );
  const { game, mapPath } = await gameWith({
    'Amira Granger.md': `# Amira\n\n${named}`,
    'Explicit Goblin.md': `# G\n\n${explicit}`,
  });
  const before = {
    amira: await readFile(path.join(game, 'NPCs', 'Amira Granger.md'), 'utf8'),
    explicit: await readFile(path.join(game, 'NPCs', 'Explicit Goblin.md'), 'utf8'),
  };
  const report = await stampGame(game, { artMap: mapPath });
  assert.equal(report.stamped.length, 0);
  assert.equal(
    await readFile(path.join(game, 'NPCs', 'Amira Granger.md'), 'utf8'),
    before.amira,
    'a named NPC has no art to stamp — the gap stays visible',
  );
  assert.equal(
    await readFile(path.join(game, 'NPCs', 'Explicit Goblin.md'), 'utf8'),
    before.explicit,
    'an author image: line is never rewritten',
  );
});

test('stampGame is idempotent — a second run stamps nothing', async () => {
  const { game, mapPath } = await gameWith({ 'Goblin.md': `# Goblin\n\n${GOBLIN_FENCE}` });
  await stampGame(game, { artMap: mapPath });
  const again = await stampGame(game, { artMap: mapPath });
  assert.equal(again.stamped.length, 0);
});
