import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(SCRIPT_DIR, 'ship-game.sh');

function run(args, env = {}) {
  return execFileSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const stderrMatches = re => err => re.test(err.stderr ?? '');

test('ship-game.sh without a game dir prints usage and fails', () => {
  assert.throws(() => run([]), stderrMatches(/Usage: ship-game\.sh/));
});

test('ship-game.sh names a missing game dir instead of failing downstream', () => {
  assert.throws(() => run(['/nowhere/definitely-not-a-game']), stderrMatches(/No such game dir/));
});

test('ship-game.sh demands exactly one module config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ship-game-'));
  const game = path.join(dir, '03 Oneshots', 'Test Game');
  await mkdir(path.join(game, 'Foundry'), { recursive: true });
  // Zero configs: the game was never scaffolded for Foundry.
  assert.throws(() => run([game]), stderrMatches(/No \*\.config\.json under/));

  // Two configs: ambiguous, refuse rather than guess.
  await writeFile(path.join(game, 'Foundry', 'a.config.json'), '{}');
  await writeFile(path.join(game, 'Foundry', 'b.config.json'), '{}');
  assert.throws(() => run([game]), stderrMatches(/more than one config/i));
});

test('ship-game.sh rejects an unknown flag', async () => {
  assert.throws(() => run(['--frobnicate']), stderrMatches(/Unknown argument/));
});
