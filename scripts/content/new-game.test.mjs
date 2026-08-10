import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
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

test('new-game.sh scaffolds a valid per-game module', async () => {
  const slug = 'zzz-test-newgame';
  await cleanup(slug);
  try {
    run([slug, '--type', 'oneshot', '--system', 'dnd5e', '--title', 'ZZZ Test']);

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
    run([slug, '--type', 'campaign']);
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
    run([slug]);
    assert.throws(() => run([slug]), stderrMatches(/already exists/));
  } finally {
    await cleanup(slug);
  }
});

test('new-game.sh rejects a bad slug and a bad type', () => {
  assert.throws(() => run(['Bad_Slug']), stderrMatches(/kebab-case/));
  assert.throws(() => run(['ok-slug', '--type', 'trilogy']), stderrMatches(/oneshot or campaign/));
});
