import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './build.mjs';
import { CUE_FLAG_SCOPE } from './cue.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const SCRIPT = path.join(SCRIPT_DIR, 'new-game.sh');
const TYPE_DIRS = ['actors', 'items', 'journals', 'macros', 'scenes', 'tables'];

function run(args) {
  return execFileSync('bash', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// execFileSync's Error.message is just "Command failed"; the script's message
// lands on err.stderr. Match against that.
const stderrMatches = re => err => re.test(err.stderr ?? '');

async function cleanup(slug) {
  await rm(path.join(REPO_ROOT, 'content', `${slug}.config.json`), { force: true });
  await rm(path.join(REPO_ROOT, 'content', `src-${slug}`), { recursive: true, force: true });
}

test('new-game.sh --in-repo scaffolds a valid per-game module', async () => {
  const slug = 'zzz-test-newgame';
  await cleanup(slug);
  try {
    run([slug, '--in-repo', '--type', 'oneshot', '--system', 'dnd5e', '--title', 'ZZZ Test']);

    const configPath = path.join(REPO_ROOT, 'content', `${slug}.config.json`);
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(raw.id, `${slug}-oneshot`);
    assert.equal(raw.srcDir, `src-${slug}`);
    assert.equal(raw.system, 'dnd5e');
    assert.equal(raw.packLabelPrefix, 'ZZZ Test');

    // The build's own loader must accept the generated config.
    const config = await loadConfig(configPath);
    assert.equal(config.id, `${slug}-oneshot`);

    for (const type of TYPE_DIRS) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, 'content', `src-${slug}`, type, '.gitkeep')),
        `expected src-${slug}/${type}/.gitkeep`,
      );
    }
  } finally {
    await cleanup(slug);
  }
});

test('new-game.sh defaults title from slug and omits system when not given', async () => {
  const slug = 'zzz-test-agnostic';
  await cleanup(slug);
  try {
    run([slug, '--in-repo', '--type', 'campaign']);
    const raw = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'content', `${slug}.config.json`), 'utf8'),
    );
    assert.equal(raw.id, `${slug}-campaign`);
    assert.equal(raw.title, 'Zzz Test Agnostic');
    assert.ok(!('system' in raw), 'system key should be omitted');
    await loadConfig(path.join(REPO_ROOT, 'content', `${slug}.config.json`));
  } finally {
    await cleanup(slug);
  }
});

test('new-game.sh refuses to clobber an existing config', async () => {
  const slug = 'zzz-test-clobber';
  await cleanup(slug);
  try {
    run([slug, '--in-repo']);
    assert.throws(() => run([slug, '--in-repo']), stderrMatches(/already exists/));
  } finally {
    await cleanup(slug);
  }
});

test('new-game.sh rejects a bad slug and a bad type', () => {
  assert.throws(() => run(['Bad_Slug']), stderrMatches(/kebab-case/));
  assert.throws(() => run(['ok-slug', '--type', 'trilogy']), stderrMatches(/oneshot or campaign/));
});

test('new-game.sh scaffolds the full vault game folder by default', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    const out = run([
      'zzz-vault-game',
      '--vault',
      vault,
      '--system',
      'dnd5e',
      '--title',
      'ZZZ Vault Game',
    ]);
    const game = path.join(vault, '03 Oneshots', 'ZZZ Vault Game');

    // Every note a finished game needs exists as a stub — the scaffold is the
    // definition of done, so a missing piece is visible in the vault.
    for (const note of ['ZZZ Vault Game.md', 'GM Prep.md', 'Advert.md', 'Soundtrack.md']) {
      assert.ok(existsSync(path.join(game, note)), `expected ${note}`);
    }
    for (const dir of [
      'Handouts',
      'Maps',
      'NPCs',
      'Scenes',
      'Tables',
      'Assets/Maps',
      'Foundry/maps',
    ]) {
      assert.ok(existsSync(path.join(game, dir)), `expected ${dir}/`);
    }
    for (const type of TYPE_DIRS) {
      assert.ok(
        existsSync(path.join(game, 'Foundry', 'src', type)),
        `expected Foundry/src/${type}/`,
      );
    }

    // A vault-hosted config must NOT carry srcDir — it resolves under the
    // repo's content/ and would silently build the wrong tree.
    const configPath = path.join(game, 'Foundry', 'zzz-vault-game.config.json');
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(raw.id, 'zzz-vault-game-oneshot');
    assert.ok(!('srcDir' in raw), 'vault config must omit srcDir');
    await loadConfig(configPath);

    assert.match(out, /Definition of done/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('a scaffolded game ships the cue reminder macro, ready to build', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    run(['zzz-vault-game', '--vault', vault, '--system', 'dnd5e']);
    const macro = JSON.parse(
      await readFile(
        path.join(
          vault,
          '03 Oneshots',
          'Zzz Vault Game',
          'Foundry',
          'src',
          'macros',
          'cue-reminder.json',
        ),
        'utf8',
      ),
    );

    // build.mjs requires all three; a macro with no command is a button that
    // does nothing, which you only discover by pressing it mid-session.
    assert.equal(macro.type, 'script');
    assert.ok(macro.name);
    assert.ok(macro.command);

    // It reads the flag compile-game.mjs writes. If either side renames the
    // scope, the reminder goes quiet rather than failing loudly — so pin it.
    assert.ok(
      macro.command.includes(CUE_FLAG_SCOPE),
      'macro must read the same flag scope the compiler writes',
    );

    // Cue text is authored in the vault but lands in chat HTML.
    assert.match(macro.command, /esc\(/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('the soundtrack sheet reads scene cues and keeps audio out of Foundry', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    run(['zzz-audio', '--vault', vault, '--system', 'dnd5e']);
    const sheet = await readFile(
      path.join(vault, '03 Oneshots', 'Zzz Audio', 'Soundtrack.md'),
      'utf8',
    );

    // The cue sheet is a query over the scene notes, not a second list to keep
    // in step with them — a cue cannot drift from the scene it belongs to.
    assert.match(sheet, /FROM "03 Oneshots\/Zzz Audio\/Scenes"/);

    // Games do not agree on how they order scene notes: some number them with a
    // `scene:` key, some use `act:`, and points-of-interest notes often carry
    // neither. Sorting on `scene` alone left one game's cue sheet in arbitrary
    // order, which for a "what to play next" sheet is a silent failure.
    assert.match(sheet, /SORT scene, act, file\.name/);

    // The three keys a scene note carries. Documented where they are used.
    for (const key of ['audio_source', 'audio_ref', 'audio_cue']) {
      assert.ok(sheet.includes(key), `expected ${key} documented in the sheet`);
    }

    // `none` means silence was chosen; a blank means nobody has decided yet.
    // The enum comment once omitted `none` while the prose below it told you
    // to write exactly that — the sheet contradicted itself in twelve lines.
    assert.match(sheet, /tabletopaudio \| spotify \| local \| none/);

    // The bot is named once per game, so the per-scene rows stay bot-agnostic
    // and switching bots is a one-line edit rather than a sweep.
    assert.match(sheet, /^audio_bot: flavibot$/m);
    assert.match(sheet, /^audio_command: "\/play \{ref\}"$/m);
    assert.match(sheet, /^soundtrack_playlist: REPLACE$/m);

    // Both tiers of the cue model are reachable from the sheet: the game
    // playlist for games that run in order, a per-scene ref for games that
    // jump around. `default()` is what makes the fallback work.
    assert.match(sheet, /default\(audio_ref, this\.soundtrack_playlist\)/);

    // The standing rule, stated in the file itself: the vault is mounted inside
    // Foundry's data root, so Foundry CAN see these files. It must not serve
    // them.
    assert.match(sheet, /Do not build Foundry playlists/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('new-game.sh puts a campaign under 02 Campaigns and skips the advert', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    run(['zzz-vault-camp', '--vault', vault, '--type', 'campaign']);
    const game = path.join(vault, '02 Campaigns', 'Zzz Vault Camp');
    assert.ok(existsSync(path.join(game, 'GM Prep.md')));
    assert.ok(!existsSync(path.join(game, 'Advert.md')), 'campaigns get no GroupFlows advert');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('new-game.sh refuses to clobber an existing game folder', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    run(['zzz-vault-dupe', '--vault', vault]);
    assert.throws(() => run(['zzz-vault-dupe', '--vault', vault]), stderrMatches(/already exists/));
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('new-game.sh errors clearly when no vault can be found', () => {
  assert.throws(
    () => run(['zzz-no-vault', '--vault', '/nonexistent/vault/path']),
    stderrMatches(/no vault found|--vault/),
  );
});
