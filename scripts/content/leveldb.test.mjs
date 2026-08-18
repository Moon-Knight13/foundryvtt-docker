import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClassicLevel } from 'classic-level';
import { isLockError, explainLevelError } from './leveldb.mjs';

test('isLockError recognises how a held lock actually surfaces', () => {
  // classic-level's shape when a second process opens the same database.
  assert.equal(isLockError({ code: 'LEVEL_DATABASE_NOT_OPEN' }), true);
  assert.equal(isLockError({ message: 'Database is not open' }), true);
  // What @foundryvtt/foundryvtt-cli reports for the same underlying condition.
  assert.equal(
    isLockError({ message: 'Iterator is not open: cannot call next() after close()' }),
    true,
  );
  assert.equal(
    isLockError({ cause: { message: 'IO error: lock /x/LOCK: already held by process' } }),
    true,
  );
});

test('isLockError does not swallow unrelated failures', () => {
  assert.equal(isLockError({ code: 'ENOENT', message: 'no such file or directory' }), false);
  assert.equal(isLockError(new Error('Unexpected end of JSON input')), false);
  assert.equal(isLockError(null), false);
});

test('explainLevelError names the cause and the fix', () => {
  const msg = explainLevelError({ code: 'LEVEL_DATABASE_NOT_OPEN' }, 'the monsters pack');
  assert.match(msg, /the monsters pack/);
  assert.match(msg, /locked by another process/);
  assert.match(msg, /docker compose stop foundry/);
});

test('explainLevelError passes real errors through untouched', () => {
  const err = new Error('Unexpected token < in JSON');
  assert.equal(explainLevelError(err, 'a pack'), 'Unexpected token < in JSON');
});

test('a genuinely held LevelDB lock is detected, not just its error string', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'leveldb-lock-'));
  const dbPath = path.join(dir, 'settings');
  const holder = new ClassicLevel(dbPath, { valueEncoding: 'json' });
  await holder.open();
  try {
    const second = new ClassicLevel(dbPath, { valueEncoding: 'json' });
    await assert.rejects(
      () => second.open(),
      err => {
        // This is the real failure a running Foundry produces; the guard has to
        // match it, not a string I invented.
        assert.ok(isLockError(err), `expected a lock error, got: ${err.message}`);
        assert.match(explainLevelError(err, 'the pack'), /docker compose stop foundry/);
        return true;
      },
    );
  } finally {
    await holder.close();
  }
});

test('a missing path is not reported as a lock', () => {
  // extractPack on a path that does not exist creates an empty database and
  // fails with the SAME "Iterator is not open" message a real lock produces.
  // Treating that as a lock sends you to stop Foundry over a path typo.
  const err = { message: 'Iterator is not open: cannot call next() after close()' };
  assert.equal(isLockError(err, { pathExists: false }), false);
  assert.equal(isLockError(err, { pathExists: true }), true);
  // An actual lock is still identified either way, because the cause says so.
  const locked = { cause: { message: 'IO error: lock /x/LOCK: already held by process' } };
  assert.equal(isLockError(locked, { pathExists: false }), true);
});

test('explainLevelError passes the path hint through', () => {
  const err = { message: 'Iterator is not open: cannot call next() after close()' };
  assert.match(explainLevelError(err, 'the pack', { pathExists: false }), /Iterator is not open/);
  assert.match(
    explainLevelError(err, 'the pack', { pathExists: true }),
    /docker compose stop foundry/,
  );
});
