import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  enabledModules,
  pinFromManifest,
  mergeCapture,
  assertOutsideRepo,
  snapshotPath,
  parseArgs,
  dataDir,
  isInstallable,
  assertDataDir,
  USAGE,
  COMMANDS,
  REPO_ROOT,
} from './foundry-base.mjs';

test('enabledModules keeps only the enabled ids, sorted', () => {
  assert.deepEqual(
    enabledModules({
      tokenmagic: true,
      'dd-import': true,
      'old-thing': false,
    }),
    ['dd-import', 'tokenmagic'],
  );
  // Absent or malformed configuration must yield nothing, not throw — a world
  // that has never been launched has no setting written yet.
  assert.deepEqual(enabledModules(null), []);
  assert.deepEqual(enabledModules('nonsense'), []);
});

test('pinFromManifest records what is needed to reinstall exactly', () => {
  const pin = pinFromManifest({
    id: 'dice-so-nice',
    version: '5.1.2',
    title: 'Dice So Nice!',
    manifest: 'https://example.invalid/module.json',
  });
  assert.deepEqual(pin, {
    id: 'dice-so-nice',
    version: '5.1.2',
    title: 'Dice So Nice!',
    manifest: 'https://example.invalid/module.json',
  });
  // Older modules use `name` rather than `id`, and some ship no manifest URL.
  const legacy = pinFromManifest({ name: 'old-mod', version: '1.0' }, 'old-mod');
  assert.equal(legacy.id, 'old-mod');
  assert.equal(legacy.manifest, '');
  assert.equal(pinFromManifest({}, 'fallback').id, 'fallback');
});

const MANIFEST = {
  core: [
    {
      id: 'dd-import',
      version: '1.0.0',
      manifest: 'https://example.invalid/dd.json',
    },
    { id: 'ddb-importer', version: '5.0.0', manifest: '' },
  ],
};

test('mergeCapture refreshes versions of modules already in core', () => {
  const { core } = mergeCapture(MANIFEST, {
    modules: [
      {
        id: 'dd-import',
        version: '1.2.0',
        manifest: 'https://example.invalid/new.json',
      },
      {
        id: 'ddb-importer',
        version: '5.4.1',
        manifest: 'https://example.invalid/ddb.json',
      },
    ],
  });
  assert.equal(core.find(m => m.id === 'dd-import').version, '1.2.0');
  // An existing pinned manifest URL wins; a blank one is filled in.
  assert.equal(core.find(m => m.id === 'dd-import').manifest, 'https://example.invalid/dd.json');
  assert.equal(
    core.find(m => m.id === 'ddb-importer').manifest,
    'https://example.invalid/ddb.json',
  );
});

test('mergeCapture reports extra modules instead of silently promoting them', () => {
  const { notInCore } = mergeCapture(MANIFEST, {
    modules: [
      { id: 'dd-import', version: '1.0.0' },
      {
        id: 'monks-active-tiles',
        version: '11.1',
        title: "Monk's Active Tiles",
      },
    ],
  });
  // Silently dropping this is how a rebuild loses every scene built on active
  // tiles; silently adding it is a decision the script does not get to make.
  assert.deepEqual(
    notInCore.map(m => m.id),
    ['monks-active-tiles'],
  );
});

test('mergeCapture reports core modules the world does not have enabled', () => {
  const { inCoreNotEnabled } = mergeCapture(MANIFEST, {
    modules: [{ id: 'dd-import', version: '1.0.0' }],
  });
  assert.deepEqual(
    inCoreNotEnabled.map(m => m.id),
    ['ddb-importer'],
  );
});

test('a snapshot inside the repo tree is refused', () => {
  // The data dir holds license.json and the admin key. A snapshot under the
  // repo is one `git add -A` away from committing a licence key.
  assert.throws(() => assertOutsideRepo(path.join(REPO_ROOT, 'backup')), /Refusing to snapshot/);
  assert.throws(() => assertOutsideRepo(REPO_ROOT), /Refusing to snapshot/);
  assert.equal(assertOutsideRepo('/var/tmp/fvtt.golden'), '/var/tmp/fvtt.golden');
  // A sibling path that merely shares a prefix is fine, not inside the repo.
  assert.ok(assertOutsideRepo(`${REPO_ROOT}-elsewhere`));
});

test('snapshotPath defaults beside the data dir and tolerates a trailing slash', () => {
  assert.equal(snapshotPath('/var/data/FoundryVTT'), '/var/data/FoundryVTT.golden');
  assert.equal(snapshotPath('/var/data/FoundryVTT/'), '/var/data/FoundryVTT.golden');
  assert.equal(snapshotPath('/var/data/FoundryVTT', '/mnt/backup'), '/mnt/backup');
});

test('parseArgs splits the command from its flags', () => {
  const o = parseArgs(['capture', 'my-world', '--data', '/d']);
  assert.equal(o.command, 'capture');
  assert.deepEqual(o.positional, ['my-world']);
  assert.equal(o.data, '/d');
  assert.equal(parseArgs(['provision', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['restore', '--yes']).yes, true);
  assert.throws(() => parseArgs(['snapshot', '--nope']), /Unknown argument/);
});

test('dataDir prefers the explicit path, then the environment', () => {
  assert.equal(dataDir('/explicit'), '/explicit');
  const prev = process.env.FOUNDRY_DATA_PATH;
  process.env.FOUNDRY_DATA_PATH = '/from-env';
  assert.equal(dataDir(), '/from-env');
  if (prev === undefined) delete process.env.FOUNDRY_DATA_PATH;
  else process.env.FOUNDRY_DATA_PATH = prev;
});

test('isInstallable treats placeholder pins as unresolved, not as URLs', () => {
  assert.equal(isInstallable({ manifest: 'https://example.invalid/module.json' }), true);
  // The starter manifest ships "TODO" on purpose — guessing a module id fails
  // at rebuild time. Fetching "TODO" as a URL would fail confusingly instead.
  assert.equal(isInstallable({ manifest: 'TODO' }), false);
  assert.equal(isInstallable({ manifest: '' }), false);
  assert.equal(isInstallable({}), false);
  assert.equal(isInstallable(null), false);
});

test('assertDataDir explains a missing data dir instead of just reporting it', async () => {
  // Running these commands in the devcontainer fails for exactly one reason:
  // the Foundry data directory is not mounted there. A bare "not found" sends
  // people hunting for a misspelled world instead.
  await assert.rejects(
    () => assertDataDir('/nonexistent-foundry-data'),
    err => {
      assert.match(err.message, /No Foundry worlds at/);
      assert.match(err.message, /--data <path>/);
      return true;
    },
  );
});

test('mergeCapture overwrites a placeholder manifest rather than keeping it', () => {
  // The original merge did `pin.manifest || fresh.manifest`, which preserved
  // "TODO" because a non-empty string is truthy — so a capture could never fill
  // the very placeholders it exists to resolve.
  const withPlaceholder = {
    core: [{ id: '_chatcommands', version: 'TODO', manifest: 'TODO', title: 'Chat Commander' }],
  };
  const { core } = mergeCapture(withPlaceholder, {
    modules: [
      {
        id: '_chatcommands',
        version: '2.0.6',
        manifest: 'https://example.invalid/_chatcommands.json',
      },
    ],
  });
  assert.equal(core[0].version, '2.0.6');
  assert.equal(core[0].manifest, 'https://example.invalid/_chatcommands.json');
  assert.equal(isInstallable(core[0]), true);
});

test('mergeCapture still protects a real pinned URL from being overwritten', () => {
  const pinned = {
    core: [{ id: 'dd-import', version: '1.0.0', manifest: 'https://example.invalid/pinned.json' }],
  };
  const { core } = mergeCapture(pinned, {
    modules: [
      { id: 'dd-import', version: '6.1.1', manifest: 'https://example.invalid/different.json' },
    ],
  });
  // Version moves with the capture; the deliberately pinned URL does not.
  assert.equal(core[0].version, '6.1.1');
  assert.equal(core[0].manifest, 'https://example.invalid/pinned.json');
});

test('every command in the usage text is actually dispatchable', () => {
  // `promote` shipped documented in USAGE, defined as cmdPromote, and missing
  // from the switch — so the tool advertised a command that answered "Unknown
  // command: promote". Nothing caught it because the module still imported
  // cleanly. This pins usage text and dispatch table to each other.
  const advertised = [...USAGE.matchAll(/^\s+foundry-base\.mjs (\S+)/gm)].map(m => m[1]);
  assert.ok(advertised.length >= 6, `expected several commands, found ${advertised.length}`);
  for (const cmd of advertised) {
    assert.ok(COMMANDS.includes(cmd), `"${cmd}" is documented but not dispatchable`);
  }
});

test('every dispatchable command is documented', () => {
  // The reverse: a command that works but nobody knows about.
  const advertised = [...USAGE.matchAll(/^\s+foundry-base\.mjs (\S+)/gm)].map(m => m[1]);
  for (const cmd of COMMANDS) {
    assert.ok(advertised.includes(cmd), `"${cmd}" is dispatchable but undocumented`);
  }
});

test('an unknown command is rejected, not silently ignored', async () => {
  const { main } = await import('./foundry-base.mjs');
  await assert.rejects(() => main(['definitely-not-a-command']), /Unknown command/);
  await assert.rejects(() => main([]), /No command given/);
});
