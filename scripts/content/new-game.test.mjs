import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './build.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const SCRIPT = path.join(SCRIPT_DIR, 'new-game.sh');
const TYPE_DIRS = ['actors', 'items', 'journals', 'scenes', 'tables'];

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

// Discord's server rules require the GM to be explicit about generative AI in
// imagery (issue #102). The disclosure is a standing line inside the paste
// block, not GM-facing scratch: it has to survive the copy into Discord.
test('the generated advert carries the AI disclosure inside the paste block', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
  try {
    run(['zzz-vault-ai', '--vault', vault, '--title', 'ZZZ Vault AI']);
    const advert = await readFile(
      path.join(vault, '03 Oneshots', 'ZZZ Vault AI', 'Advert.md'),
      'utf8',
    );
    const block = advert.split('```')[1] ?? '';
    assert.match(block, /\*\*AI disclosure:\*\*/, 'expected an AI heading in the pasted block');
    assert.match(block, /portrait tokens are AI-drawn/i, 'expected the token-art disclosure');
    assert.match(block, /not\s+AI-generated/i, 'expected maps called out as not AI-generated');
    assert.match(block, /never AI is the game/i, 'expected the no-AI-at-the-table line');

    // The three objections players actually raise. Stating that a model was
    // involved without answering these reads as a technicality, so each one is
    // load-bearing: training provenance, displaced artists, and an opt-out.
    assert.match(block, /not an image generator/i, 'expected the training-provenance answer');
    assert.match(
      block,
      /never instead of paying an artist/i,
      'expected the displaced-artist answer',
    );
    assert.match(block, /plain tokens/i, 'expected the opt-out offer');

    // The writing disclosure is volunteered -- the server rule covers imagery
    // only -- so nothing external will catch its removal. Pin it here.
    assert.match(block, /writing is Claude-assisted/i, 'expected the writing disclosure');
    assert.match(block, /signed off on/i, 'expected the human-approval commitment');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

// Both copies of the advert -- the Templater template and new-game.sh's
// heredoc -- must state the same thing, or the two paths disagree about what
// players were told.
test('the advert template and the scaffolded advert make the same AI claim', async () => {
  const template = await readFile(
    path.join(REPO_ROOT, 'examples', 'vault-skeleton', '05 Templates', 'Advert Template.md'),
    'utf8',
  );
  const script = await readFile(SCRIPT, 'utf8');
  const claim = /A few NPC portrait tokens are AI-drawn/;
  assert.match(template, claim, 'advert template is missing the AI disclosure');
  assert.match(script, claim, 'new-game.sh is missing the AI disclosure');
});
