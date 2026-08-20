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
  addToCore,
  removeFromCore,
  sharedPrefix,
  pullPlan,
  loadGames,
  REPO_ROOT,
} from './foundry-base.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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

const BASE = {
  core: [{ id: 'dd-import', version: '6.1.1', manifest: 'https://example.invalid/dd.json' }],
};

test('addToCore appends a module the rebuild turned out to need', () => {
  const { core, action } = addToCore(BASE, {
    id: 'tokenmagic',
    version: '0.8.3',
    manifest: 'https://example.invalid/tm.json',
    title: 'Token Magic FX',
  });
  assert.equal(action, 'added');
  assert.equal(core.length, 2);
  assert.equal(core[1].id, 'tokenmagic');
});

test('adding the same module twice updates rather than duplicating', () => {
  // The adjust loop is iterative — re-running `add` after another rebuild must
  // not leave two entries that then fight during provision.
  const once = addToCore(BASE, {
    id: 'tokenmagic',
    version: '0.8.3',
    manifest: 'https://a.invalid/x.json',
  });
  const twice = addToCore(
    { core: once.core },
    {
      id: 'tokenmagic',
      version: '0.9.0',
      manifest: 'https://a.invalid/x.json',
    },
  );
  assert.equal(twice.action, 'updated');
  assert.equal(twice.core.filter(m => m.id === 'tokenmagic').length, 1);
  assert.equal(twice.core.find(m => m.id === 'tokenmagic').version, '0.9.0');
});

test('addToCore keeps a note and a deliberately pinned URL', () => {
  const withNote = addToCore(
    BASE,
    { id: 'tokenmagic', version: '0.8.3', manifest: 'https://a.invalid/x.json' },
    {
      note: 'Dependency of several QoL modules.',
    },
  );
  // Re-adding without a note must not erase the reason someone wrote down.
  const again = addToCore(
    { core: withNote.core },
    {
      id: 'tokenmagic',
      version: '0.8.4',
      manifest: 'https://b.invalid/other.json',
    },
  );
  const entry = again.core.find(m => m.id === 'tokenmagic');
  assert.equal(entry.note, 'Dependency of several QoL modules.');
  assert.equal(entry.manifest, 'https://a.invalid/x.json', 'the pinned URL wins');
});

test('removeFromCore drops a module and reports a no-op honestly', () => {
  const gone = removeFromCore(BASE, 'dd-import');
  assert.equal(gone.removed, true);
  assert.equal(gone.core.length, 0);

  const nothing = removeFromCore(BASE, 'never-there');
  assert.equal(nothing.removed, false);
  assert.equal(nothing.core.length, 1);
});

test('pull-games gates every game on art coverage between build and sync', () => {
  // The gate BETWEEN build and sync is the point: an unproven module must not
  // be able to reach Foundry through the batch path.
  const plan = pullPlan({ config: '/v/g/ashwake-hollow.config.json', src: '/v/g/src' });
  assert.equal(plan.length, 3);
  const scripts = plan.map(([cmd, args]) => path.basename(cmd === 'node' ? args[0] : cmd));
  assert.deepEqual(scripts, ['build.mjs', 'art-coverage.mjs', 'sync-content.sh']);

  const gateArgs = plan[1][1];
  assert.ok(gateArgs.includes('--strict'), 'the batch path is the enforcing one');
  assert.ok(gateArgs.includes('/v/g/ashwake-hollow.config.json'));
  assert.ok(gateArgs.includes('/v/g/src'), 'vault-hosted games pass their src through');

  // A plain-string manifest entry (config only) still gets all three steps.
  const plain = pullPlan('/v/g/ashwake-hollow.config.json');
  assert.equal(plain.length, 3);
  assert.ok(!plain[1][1].includes('--src'));
});

test('loadGames merges the vault-side registry so the repo stays game-agnostic', async () => {
  const saved = process.env.DND_VAULT_PATH;
  const vault = await mkdtemp(path.join(tmpdir(), 'vault-'));
  try {
    process.env.DND_VAULT_PATH = vault;
    // No registry file: repo manifest games only (normally []).
    assert.deepEqual(await loadGames({ games: [] }), []);
    // Registry present: its entries are picked up without touching the repo.
    await writeFile(
      path.join(vault, 'foundry-games.json'),
      JSON.stringify({
        games: [
          { config: '$DND_VAULT_PATH/g/ashwake-hollow.config.json', src: '$DND_VAULT_PATH/g/src' },
        ],
      }),
    );
    const games = await loadGames({ games: [] });
    assert.equal(games.length, 1);
    assert.equal(games[0].config, '$DND_VAULT_PATH/g/ashwake-hollow.config.json');
    // Repo entries (if any ever exist) come first; vault entries append.
    const merged = await loadGames({ games: ['/repo/one.config.json'] });
    assert.deepEqual(merged[0], '/repo/one.config.json');
    assert.equal(merged.length, 2);
    // Malformed registry fails loud, not silently empty.
    await writeFile(path.join(vault, 'foundry-games.json'), '{nope');
    await assert.rejects(() => loadGames({ games: [] }), /foundry-games\.json/);
  } finally {
    if (saved === undefined) delete process.env.DND_VAULT_PATH;
    else process.env.DND_VAULT_PATH = saved;
  }
});

test('pullPlan expands a leading $DND_VAULT_PATH from the environment', () => {
  const saved = process.env.DND_VAULT_PATH;
  try {
    process.env.DND_VAULT_PATH = '/vault';
    const plan = pullPlan({
      config: '$DND_VAULT_PATH/03 Oneshots/Ashwake Hollow/Foundry/ashwake-hollow.config.json',
      src: '$DND_VAULT_PATH/03 Oneshots/Ashwake Hollow/Foundry/src',
    });
    assert.ok(
      plan[0][1].includes('/vault/03 Oneshots/Ashwake Hollow/Foundry/ashwake-hollow.config.json'),
    );
    assert.ok(plan[1][1].includes('/vault/03 Oneshots/Ashwake Hollow/Foundry/src'));

    // Unset: falls back to the compose default, ~/Documents/DnD.
    delete process.env.DND_VAULT_PATH;
    const fallback = pullPlan('$DND_VAULT_PATH/g/ashwake-hollow.config.json');
    assert.ok(
      fallback[0][1].some(a => a.endsWith('/Documents/DnD/g/ashwake-hollow.config.json')),
      `expected ~/Documents/DnD fallback, got ${fallback[0][1]}`,
    );
  } finally {
    if (saved === undefined) delete process.env.DND_VAULT_PATH;
    else process.env.DND_VAULT_PATH = saved;
  }
});

test('sharedPrefix powers a "did you mean" that actually fires on typos', () => {
  // A typo shares a PREFIX with the real id far more often than it contains it,
  // so substring matching alone stayed silent exactly when it was most wanted.
  assert.ok(sharedPrefix('tokenmagic', 'tokenmagik') >= 4);
  assert.ok(sharedPrefix('dd-import', 'tokenmagic') < 4);
  assert.equal(sharedPrefix('', 'x'), 0);
});
