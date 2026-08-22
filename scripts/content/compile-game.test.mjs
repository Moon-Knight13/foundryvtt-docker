import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileGame } from './compile-game.mjs';
import { CUE_FLAG_SCOPE } from './cue.mjs';

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

/** Add a Soundtrack.md, a Scenes/ note, and the scene JSON it maps onto. */
async function cueFixture({
  sceneFrontmatter,
  sheet = SOUNDTRACK,
  scene = { name: 'The Belfry' },
}) {
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Scenes'), { recursive: true });
  await mkdir(path.join(gameDir, 'Foundry', 'src', 'scenes'), { recursive: true });
  if (sheet !== null) await writeFile(path.join(gameDir, 'Soundtrack.md'), sheet);
  await writeFile(
    path.join(gameDir, 'Scenes', 'The Belfry.md'),
    `---\n${sceneFrontmatter}\n---\n\n# The Belfry\n`,
  );
  const out = path.join(gameDir, 'Foundry', 'src', 'scenes', 'the-belfry.json');
  if (scene !== null) await writeFile(out, `${JSON.stringify(scene, null, 2)}\n`);
  return { gameDir, out };
}

const SOUNDTRACK =
  '---\naudio_bot: flavibot\naudio_command: "/play {ref}"\nsoundtrack_playlist: game-list\n---\n\n# Sheet\n';

async function audioOf(out) {
  return JSON.parse(await readFile(out, 'utf8')).flags[CUE_FLAG_SCOPE].audio;
}

test('a scene note stamps its cue and a paste-ready command onto its scene', async () => {
  const { gameDir, out } = await cueFixture({
    sceneFrontmatter:
      'audio_source: spotify\naudio_ref: belfry-list\naudio_cue: as the bells start',
  });
  const report = await compileGame(gameDir);

  assert.equal(report.cues.length, 1);
  assert.equal(report.cues[0].skipped, false);
  assert.deepEqual(await audioOf(out), {
    source: 'spotify',
    ref: 'belfry-list',
    cue: 'as the bells start',
    command: '/play belfry-list',
    bot: 'flavibot',
  });
});

test('a scene with no ref of its own falls back to the game playlist', async () => {
  const { gameDir, out } = await cueFixture({
    sceneFrontmatter: 'audio_source: spotify\naudio_cue: as the doors close',
  });
  await compileGame(gameDir);
  const audio = await audioOf(out);
  assert.equal(audio.ref, 'game-list');
  assert.equal(audio.command, '/play game-list');
});

test('deliberate silence stamps nothing at all', async () => {
  const { gameDir, out } = await cueFixture({ sceneFrontmatter: 'audio_source: none' });
  const report = await compileGame(gameDir);
  assert.equal(report.cues.length, 0);
  const scene = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(scene.flags?.[CUE_FLAG_SCOPE], undefined);
});

test('a scene note that has no scene JSON yet warns, and does not fail the run', async () => {
  // Scene notes routinely land before their map does. Losing the whole
  // compile over one is worse than saying so and carrying on.
  const { gameDir } = await cueFixture({
    sceneFrontmatter: 'audio_source: spotify\naudio_cue: later',
    scene: null,
  });
  const report = await compileGame(gameDir);

  assert.equal(report.errors.length, 0);
  assert.equal(report.cues.length, 1);
  assert.equal(report.cues[0].skipped, true);
  assert.match(report.cues[0].warning, /no scene JSON yet/);
});

test('a cue survives its scene being regenerated from the map', async () => {
  // dd2vtt-to-scene.mjs rewrites the scene JSON wholesale, which leaves it
  // NEWER than the note and carrying no cue. An mtime check would call that
  // file current and drop the cue silently — so cues are recomputed instead.
  const { gameDir, out } = await cueFixture({
    sceneFrontmatter: 'audio_source: spotify\naudio_ref: belfry-list\naudio_cue: bells',
  });
  await compileGame(gameDir);
  await writeFile(out, `${JSON.stringify({ name: 'The Belfry' }, null, 2)}\n`);

  await compileGame(gameDir);
  assert.equal((await audioOf(out)).ref, 'belfry-list');
});

test('recompiling an unedited game rewrites nothing', async () => {
  const { gameDir, out } = await cueFixture({
    sceneFrontmatter: 'audio_source: spotify\naudio_cue: bells',
  });
  await compileGame(gameDir);
  const before = (await stat(out)).mtimeMs;

  const report = await compileGame(gameDir);
  assert.equal(report.cues[0].skipped, true);
  assert.equal((await stat(out)).mtimeMs, before);
});

test('a game with no Soundtrack.md still gets its cue text', async () => {
  const { gameDir, out } = await cueFixture({
    sceneFrontmatter: 'audio_source: local\naudio_cue: as the chanting starts',
    sheet: null,
  });
  await compileGame(gameDir);
  const audio = await audioOf(out);
  assert.equal(audio.cue, 'as the chanting starts');
  assert.equal(audio.command, null);
});

const PREGEN_NOTE = `---
type: pregen
---

\`\`\`pregen
name: Elf Wizard
edition: '2014'
class: wizard
level: 1
species: High Elf
background: Sage
abilities: { str: 10, dex: 15, con: 14, int: 16, wis: 12, cha: 8 }
skills: [Arcana, Investigation]
ac: 12
speed: 30
\`\`\`
`;

test('a Pregens note compiles to a character actor', async () => {
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Pregens'), { recursive: true });
  await writeFile(path.join(gameDir, 'Pregens', 'Elf Wizard.md'), PREGEN_NOTE);

  const report = await compileGame(gameDir);
  assert.deepEqual(report.errors, []);
  assert.equal(report.pregens.length, 1);

  // The `pregen-` prefix keeps player characters out of the NPC namespace, in
  // the compendium and in the Dataview roster query that lists NPCs.
  const out = path.join(gameDir, 'Foundry', 'src', 'actors', 'pregen-elf-wizard.json');
  const actor = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(actor.type, 'character');
  assert.equal(actor.items[0].system.levels, 1);
  assert.equal(actor.system.abilities.int.proficient, 1, 'wizards are proficient in INT saves');
});

test('pregens and NPCs compile in the same pass without colliding', async () => {
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Pregens'), { recursive: true });
  await writeFile(path.join(gameDir, 'Pregens', 'Elf Wizard.md'), PREGEN_NOTE);

  const report = await compileGame(gameDir);
  assert.equal(report.actors.length, 1, 'the goblin');
  assert.equal(report.pregens.length, 1, 'the wizard');
  const npc = JSON.parse(
    await readFile(path.join(gameDir, 'Foundry', 'src', 'actors', 'gate-goblin.json'), 'utf8'),
  );
  assert.equal(npc.type, 'npc');
});

test('a prose note in Pregens/ is left alone', async () => {
  // `Pregens.md`-style index notes live alongside the characters; a folder walk
  // that compiled every file would fail on them.
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Pregens'), { recursive: true });
  await writeFile(path.join(gameDir, 'Pregens', 'README.md'), '# Pregens\n\nHand these out.\n');

  const report = await compileGame(gameDir);
  assert.deepEqual(report.errors, []);
  assert.equal(report.pregens.length, 0);
});

test('a broken pregen is reported without abandoning the rest', async () => {
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Pregens'), { recursive: true });
  await writeFile(path.join(gameDir, 'Pregens', 'Elf Wizard.md'), PREGEN_NOTE);
  await writeFile(
    path.join(gameDir, 'Pregens', 'Broken.md'),
    '```pregen\nclass: artificer\nlevel: 3\nabilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }\n```\n',
  );

  const report = await compileGame(gameDir);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /Unknown class "artificer"/);
  assert.equal(report.pregens.length, 1, 'the good one still compiled');
});

test('an unchanged pregen note is not recompiled', async () => {
  const { gameDir } = await gameFixture();
  await mkdir(path.join(gameDir, 'Pregens'), { recursive: true });
  await writeFile(path.join(gameDir, 'Pregens', 'Elf Wizard.md'), PREGEN_NOTE);

  await compileGame(gameDir);
  const second = await compileGame(gameDir);
  assert.equal(second.pregens[0].skipped, true);
});
