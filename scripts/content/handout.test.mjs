import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseEmbeds,
  parseFrontmatter,
  resolveAsset,
  dataRelative,
  imagePage,
  handoutJournal,
  parseArgs,
  gameDirFor,
  compileHandout,
  slug,
  OWNERSHIP,
} from './handout.mjs';

test('parseEmbeds finds wikilink and markdown image embeds, in order', () => {
  const md = 'Intro\n\n![[ransom-note.webp]]\n\ntext\n\n![The seal](seal.png)\n';
  assert.deepEqual(parseEmbeds(md), [
    { file: 'ransom-note.webp', caption: '' },
    { file: 'seal.png', caption: 'The seal' },
  ]);
});

test('parseEmbeds reads a wikilink alias as the caption', () => {
  assert.deepEqual(parseEmbeds('![[map.webp|A crooked charcoal map]]'), [
    { file: 'map.webp', caption: 'A crooked charcoal map' },
  ]);
});

test('parseEmbeds ignores commented-out embeds', () => {
  // The Handout template ships `<!-- Attach art: ![[<img>.jpg]] -->` as a hint.
  // Picking that up would make every scaffolded note claim art it lacks.
  assert.deepEqual(parseEmbeds('<!-- Attach art: ![[<img>.jpg]] -->'), []);
  assert.deepEqual(parseEmbeds('<!-- ![[old.webp]] -->\n![[real.webp]]'), [
    { file: 'real.webp', caption: '' },
  ]);
});

test('parseEmbeds ignores non-image embeds and de-duplicates', () => {
  // A note transclusion is not art.
  assert.deepEqual(parseEmbeds('![[Some Other Note]]'), []);
  assert.deepEqual(parseEmbeds('![[a.pdf]]'), []);
  assert.deepEqual(parseEmbeds('![[a.webp]]\n![[a.webp]]'), [{ file: 'a.webp', caption: '' }]);
});

test('dataRelative builds the path Foundry resolves through the vault mount', () => {
  // Same convention scene backgrounds already use.
  assert.equal(
    dataRelative(path.join('03 Oneshots', 'My Game', 'Assets', 'Art', 'x.webp')),
    'DnD/03 Oneshots/My Game/Assets/Art/x.webp',
  );
});

test('imagePage puts src at the top level and the caption under image', () => {
  const p = imagePage({ file: 'seal.webp', caption: 'A wax seal', src: 'DnD/g/seal.webp' }, 2, 100);
  assert.equal(p.type, 'image');
  assert.equal(p.src, 'DnD/g/seal.webp');
  assert.equal(p.image.caption, 'A wax seal');
  assert.equal(p.name, 'A wax seal');
  assert.equal(p.ownership.default, 2);
});

test('imagePage names the page from the filename when there is no caption', () => {
  const p = imagePage({ file: 'ransom-note.webp', caption: '', src: 'DnD/g/r.webp' }, 2, 100);
  assert.equal(p.name, 'ransom-note');
  assert.equal(p.image.caption, '');
});

test('handoutJournal is player-visible so players can reopen the art', () => {
  const j = handoutJournal('The Ransom Note', [
    { file: 'a.webp', caption: '', src: 'DnD/a.webp' },
    { file: 'b.webp', caption: 'Reverse', src: 'DnD/b.webp' },
  ]);
  // OBSERVER, not owner: the GM still drives "Show to Players", but a player
  // can open it again later from their own journal.
  assert.equal(j.ownership.default, OWNERSHIP.OBSERVER);
  assert.ok(j.pages.every(p => p.ownership.default === OWNERSHIP.OBSERVER));
  assert.equal(j.pages.length, 2);
  assert.deepEqual(
    j.pages.map(p => p.sort),
    [100, 200],
  );
});

test('handoutJournal name cannot collide with the Obsidian Bridge prose journal', () => {
  // The vault's rule: one journal, one pipe. The bridge owns "The Ransom Note";
  // this owns the art beside it.
  assert.equal(handoutJournal('The Ransom Note', []).name, 'The Ransom Note — Art');
});

test('a GM-only handout stays GM-only', () => {
  const j = handoutJournal('Secret Dossier', [{ file: 'a.webp', caption: '', src: 'DnD/a.webp' }], {
    playerVisible: false,
  });
  assert.equal(j.ownership.default, OWNERSHIP.GM_ONLY);
  assert.equal(j.pages[0].ownership.default, OWNERSHIP.GM_ONLY);
});

test('parseFrontmatter reads player_visible', () => {
  assert.equal(
    parseFrontmatter('---\ntype: handout\nplayer_visible: false\n---\n').player_visible,
    false,
  );
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {});
});

test('gameDirFor climbs out of Handouts/ to the game folder', () => {
  assert.equal(gameDirFor('/v/03 Oneshots/My Game/Handouts/Note.md'), '/v/03 Oneshots/My Game');
  // A note somewhere else falls back to its own directory.
  assert.equal(gameDirFor('/v/03 Oneshots/My Game/Note.md'), '/v/03 Oneshots/My Game');
});

test('parseArgs requires a note and rejects junk', () => {
  assert.throws(() => parseArgs([]), /Missing <note.md>/);
  assert.throws(() => parseArgs(['n.md', '--nope']), /Unknown argument/);
  assert.equal(parseArgs(['n.md', '--vault', '/v']).vault, '/v');
});

test('slug keeps filenames kebab-case so ids stay stable', () => {
  assert.equal(slug("Traveller's Map"), 'travellers-map');
});

/** Build a small vault: one game, one handout, art in Assets/Art. */
async function fixture() {
  const vault = await mkdtemp(path.join(tmpdir(), 'handout-vault-'));
  const game = path.join(vault, '03 Oneshots', 'My Game');
  await mkdir(path.join(game, 'Handouts'), { recursive: true });
  await mkdir(path.join(game, 'Assets', 'Art'), { recursive: true });
  await writeFile(path.join(game, 'Assets', 'Art', 'crooked-map.webp'), 'fake');
  return { vault, game };
}

test('resolveAsset finds a bare wikilink name inside the game folder', async () => {
  const { vault, game } = await fixture();
  const rel = await resolveAsset('crooked-map.webp', {
    noteDir: path.join(game, 'Handouts'),
    gameDir: game,
    vaultRoot: vault,
  });
  assert.equal(rel, path.join('03 Oneshots', 'My Game', 'Assets', 'Art', 'crooked-map.webp'));
});

test('resolveAsset returns null when the file is nowhere in the vault', async () => {
  const { vault, game } = await fixture();
  assert.equal(
    await resolveAsset('missing.webp', {
      noteDir: path.join(game, 'Handouts'),
      gameDir: game,
      vaultRoot: vault,
    }),
    null,
  );
});

test('compileHandout turns a real note into player-visible image pages', async () => {
  const { vault, game } = await fixture();
  const note = path.join(game, 'Handouts', "Traveller's Map.md");
  await writeFile(
    note,
    '---\ntype: handout\nplayer_visible: true\n---\n\n# The Map\n\nProse the bridge owns.\n\n![[crooked-map.webp|Drawn in charcoal]]\n',
  );

  const { journal, resolved, unresolved, playerVisible } = await compileHandout(note, {
    vault,
  });

  assert.deepEqual(unresolved, []);
  assert.equal(playerVisible, true);
  assert.equal(journal.name, "Traveller's Map — Art");
  assert.equal(journal.pages.length, 1, 'prose is NOT emitted — the bridge owns it');
  assert.equal(journal.pages[0].type, 'image');
  assert.equal(journal.pages[0].src, 'DnD/03 Oneshots/My Game/Assets/Art/crooked-map.webp');
  assert.equal(journal.pages[0].image.caption, 'Drawn in charcoal');
  assert.equal(resolved.length, 1);
});

test('compileHandout reports an embed it cannot find rather than shipping a blank frame', async () => {
  const { vault, game } = await fixture();
  const note = path.join(game, 'Handouts', 'Broken.md');
  await writeFile(note, '---\ntype: handout\n---\n\n![[nope.webp]]\n');
  const { unresolved, journal } = await compileHandout(note, { vault });
  assert.deepEqual(unresolved, ['nope.webp']);
  assert.equal(journal.pages.length, 0);
});

test('compileHandout refuses to guess without a vault root', async () => {
  const { game } = await fixture();
  const note = path.join(game, 'Handouts', 'X.md');
  await writeFile(note, '![[a.webp]]');
  await assert.rejects(() => compileHandout(note, {}), /No vault root/);
});

test('the emitted journal is valid input for the compendium build', async () => {
  const { vault, game } = await fixture();
  const note = path.join(game, 'Handouts', 'Art.md');
  await writeFile(note, '---\ntype: handout\n---\n\n![[crooked-map.webp]]\n');
  const { journal } = await compileHandout(note, { vault });

  const out = path.join(game, 'Foundry', 'src', 'journals', 'art-art.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(journal, null, 2)}\n`);
  const round = JSON.parse(await readFile(out, 'utf8'));

  // build.mjs requires a name and assigns ids itself from the file path.
  assert.equal(typeof round.name, 'string');
  assert.ok(Array.isArray(round.pages));
  assert.ok(round.pages.every(p => p.name && p.type === 'image' && p.src));
});
