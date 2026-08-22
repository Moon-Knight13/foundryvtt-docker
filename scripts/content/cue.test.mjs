import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CUE_FLAG_SCOPE, readGameAudio, resolveCommand, resolveCue, stampCue } from './cue.mjs';

test('resolveCommand substitutes the ref into the game-level template', () => {
  assert.equal(
    resolveCommand('/play {ref}', 'https://open.spotify.com/x'),
    '/play https://open.spotify.com/x',
  );
});

test('resolveCommand returns null rather than a half-built command', () => {
  // The sheet's whole promise is that the cell can be pasted without being
  // read first. "/play {ref}" pasted into Discord plays nothing and looks
  // like it should have worked — worse than an empty cell.
  assert.equal(resolveCommand('/play {ref}', null), null);
  assert.equal(resolveCommand(null, 'anything'), null);
});

test('resolveCommand leaves a template with no placeholder alone', () => {
  // Some bots resume with a bare command and no argument.
  assert.equal(resolveCommand('/resume', 'ignored'), '/resume');
});

test('a scene ref wins over the game playlist', () => {
  const cue = resolveCue(
    { audio_source: 'spotify', audio_ref: 'scene-list', audio_cue: 'boat leaves' },
    { command: '/play {ref}', playlist: 'game-list', bot: 'flavibot' },
  );
  assert.equal(cue.ref, 'scene-list');
  assert.equal(cue.command, '/play scene-list');
  assert.equal(cue.cue, 'boat leaves');
  assert.equal(cue.bot, 'flavibot');
});

test('a scene with no ref falls back to the game playlist', () => {
  // The two-tier model: games that run start-to-finish set one playlist and
  // skip through it, so their scene notes carry cue text and nothing else.
  const cue = resolveCue(
    { audio_source: 'spotify', audio_cue: 'the doors close' },
    { command: '/play {ref}', playlist: 'game-list' },
  );
  assert.equal(cue.ref, 'game-list');
  assert.equal(cue.command, '/play game-list');
});

test('deliberate silence is not a cue', () => {
  assert.equal(resolveCue({ audio_source: 'none' }, { playlist: 'game-list' }), null);
});

test('a scene that has not been decided yet is not a cue', () => {
  assert.equal(resolveCue({}, { playlist: 'game-list' }), null);
  assert.equal(resolveCue({ type: 'scene', scene: 3 }, { playlist: 'game-list' }), null);
});

test('cue text alone is enough, with or without a bot', () => {
  // An in-person game may never name a bot. The cue still belongs on the
  // scene — it is the sentence that tells you when to change the record.
  const cue = resolveCue({ audio_cue: 'as the chanting starts' }, {});
  assert.equal(cue.cue, 'as the chanting starts');
  assert.equal(cue.command, null);
  assert.equal(cue.ref, null);
});

test('stampCue writes under our scope and preserves foreign flags', () => {
  const scene = { name: 'The Belfry', flags: { 'some-other-module': { keep: true } } };
  const { scene: out, changed } = stampCue(scene, { cue: 'bells' });
  assert.equal(changed, true);
  assert.deepEqual(out.flags[CUE_FLAG_SCOPE].audio, { cue: 'bells' });
  assert.deepEqual(out.flags['some-other-module'], { keep: true });
  assert.equal(scene.flags[CUE_FLAG_SCOPE], undefined, 'input is not mutated');
});

test('stampCue reports no change when the cue already matches', () => {
  // compile-game.mjs recomputes cues on every run rather than trusting
  // mtimes, so this is what keeps an unedited game from churning its files.
  const first = stampCue({ name: 'The Belfry' }, { cue: 'bells' });
  const second = stampCue(first.scene, { cue: 'bells' });
  assert.equal(second.changed, false);
});

test('readGameAudio reads the bot syntax once per game', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cue-'));
  await writeFile(
    path.join(dir, 'Soundtrack.md'),
    '---\naudio_bot: flavibot\naudio_command: "/play {ref}"\nsoundtrack_playlist: https://x/y\n---\n\n# Sheet\n',
  );
  assert.deepEqual(await readGameAudio(dir), {
    bot: 'flavibot',
    command: '/play {ref}',
    playlist: 'https://x/y',
  });
});

test('a game with no Soundtrack.md is not an error', async () => {
  // Games predating the sheet still get their cue text compiled; they just
  // get no paste-ready command with it.
  const dir = await mkdtemp(path.join(tmpdir(), 'cue-'));
  assert.deepEqual(await readGameAudio(dir), { bot: null, command: null, playlist: null });
});
