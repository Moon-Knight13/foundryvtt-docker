import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileGame } from './compile-game.mjs';

const GOBLIN_NOTE = `---
type: npc
---

\`\`\`statblock
name: Gate Goblin
source: "SRD 5.1 (CC-BY-4.0) — Goblin"
type: humanoid
ac: 15
hp: 7
cr: 0.25
stats: [8, 14, 10, 10, 8, 8]
\`\`\`
`;

async function gameFixture() {
  const vault = await mkdtemp(path.join(tmpdir(), 'compile-game-'));
  const gameDir = path.join(vault, '03 Oneshots', 'Test Game');
  await mkdir(path.join(gameDir, 'NPCs'), { recursive: true });
  await mkdir(path.join(gameDir, 'Handouts'), { recursive: true });
  await mkdir(path.join(gameDir, 'Assets', 'Art'), { recursive: true });
  await writeFile(path.join(gameDir, 'NPCs', 'Gate Goblin.md'), GOBLIN_NOTE);
  await writeFile(path.join(gameDir, 'NPCs', 'Prose Only.md'), '# Just prose, no fence\n');
  await writeFile(path.join(gameDir, 'Assets', 'Art', 'wanted-poster.webp'), 'img');
  await writeFile(
    path.join(gameDir, 'Handouts', 'Wanted Poster.md'),
    '---\nplayer_visible: true\n---\n\n![[wanted-poster.webp|The poster]]\n',
  );
  await writeFile(path.join(gameDir, 'Handouts', 'No Images.md'), 'Prose handout, no art.\n');
  return { vault, gameDir };
}

test('compileGame compiles every fence note and image handout, skips the rest', async () => {
  const { gameDir } = await gameFixture();
  const report = await compileGame(gameDir);

  assert.equal(report.actors.length, 1, 'prose-only NPC note is not an actor');
  assert.equal(report.actors[0].skipped, false);
  const actor = JSON.parse(
    await readFile(path.join(gameDir, 'Foundry/src/actors/gate-goblin.json'), 'utf8'),
  );
  assert.equal(actor.name, 'Gate Goblin');

  assert.equal(report.handouts.length, 1, 'handout without embeds is not a journal');
  const journal = JSON.parse(
    await readFile(path.join(gameDir, 'Foundry/src/journals/wanted-poster-art.json'), 'utf8'),
  );
  assert.equal(journal.pages.length, 1);
  assert.deepEqual(report.errors, []);
});

test('a second run skips fresh outputs; --force recompiles', async () => {
  const { gameDir } = await gameFixture();
  await compileGame(gameDir);
  const again = await compileGame(gameDir);
  assert.ok(again.actors[0].skipped, 'output newer than note — nothing to do');
  assert.ok(again.handouts[0].skipped);

  const forced = await compileGame(gameDir, { force: true });
  assert.equal(forced.actors[0].skipped, false);
});

test('an edited note recompiles without --force', async () => {
  const { gameDir } = await gameFixture();
  await compileGame(gameDir);
  const note = path.join(gameDir, 'NPCs', 'Gate Goblin.md');
  const future = new Date(Date.now() + 5_000);
  await utimes(note, future, future);
  const report = await compileGame(gameDir);
  assert.equal(report.actors[0].skipped, false);
});

test('one broken note does not abandon the rest of the game', async () => {
  const { gameDir } = await gameFixture();
  await writeFile(
    path.join(gameDir, 'Handouts', 'Broken.md'),
    '![[does-not-exist-anywhere.webp]]\n',
  );
  const report = await compileGame(gameDir);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /Broken\.md/);
  assert.match(report.errors[0], /does-not-exist-anywhere/);
  assert.equal(report.actors.length, 1, 'the goblin still compiled');
});
