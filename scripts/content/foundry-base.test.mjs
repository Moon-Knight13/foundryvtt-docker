import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  enabledModules,
  pinFromManifest,
  mergeCapture,
  assertOutsideRepo,
  snapshotPath,
  partitionSettings,
  worldShape,
  captureWorld,
  installEntry,
  requiredIds,
  verifyPins,
  verifyDependencies,
  verifyWorldModules,
  verifyWorldSystem,
  redactSecrets,
  SECRET_KEY_PATTERN,
  IDENTITY_SETTINGS,
  syncExcludes,
  rsyncArgs,
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
import { mkdtemp, writeFile, mkdir, rm, readFile, access } from 'node:fs/promises';
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

test('snapshotPath defaults beside the data dir and names the mode', () => {
  // A full snapshot used to default to `.golden`, which is how someone restores
  // the wrong thing on game night. The path now says which of the two it is.
  assert.equal(snapshotPath('/var/data/FoundryVTT'), '/var/data/FoundryVTT.backup');
  assert.equal(snapshotPath('/var/data/FoundryVTT/'), '/var/data/FoundryVTT.backup');
  assert.equal(
    snapshotPath('/var/data/FoundryVTT', undefined, { golden: true }),
    '/var/data/FoundryVTT.golden',
  );
  assert.equal(
    snapshotPath('/var/data/FoundryVTT/', undefined, { golden: true }),
    '/var/data/FoundryVTT.golden',
  );
  // An explicit --to/--from wins in either mode, and is still repo-guarded.
  assert.equal(snapshotPath('/var/data/FoundryVTT', '/mnt/backup'), '/mnt/backup');
  assert.equal(
    snapshotPath('/var/data/FoundryVTT', '/mnt/backup', { golden: true }),
    '/mnt/backup',
  );
});

test('a full sync keeps worlds and always skips the vault mount', () => {
  assert.deepEqual(syncExcludes(), ['/Data/DnD/']);
  assert.deepEqual(syncExcludes({ golden: false }), ['/Data/DnD/']);
});

test('a golden sync additionally skips worlds', () => {
  assert.deepEqual(syncExcludes({ golden: true }), ['/Data/DnD/', '/Data/worlds/']);
});

test('rsyncArgs protects excluded paths from --delete', () => {
  // This is the whole safety property of `restore --golden`: rsync --delete
  // removes receiver files missing from the source, but --exclude protects
  // them. Without the exclude, restoring a worlds-free golden snapshot would
  // delete every live world.
  const args = rsyncArgs('/src/', '/dst/', { golden: true });
  assert.deepEqual(args, [
    '-a',
    '--delete',
    '--exclude',
    '/Data/DnD/',
    '--exclude',
    '/Data/worlds/',
    '/src/',
    '/dst/',
  ]);
  assert.ok(!args.includes('--delete-excluded'), 'must never delete excluded paths');

  // A full sync carries worlds through: no worlds exclude, so they are synced.
  const full = rsyncArgs('/src/', '/dst/');
  assert.ok(!full.includes('/Data/worlds/'));
  assert.deepEqual(full.slice(0, 2), ['-a', '--delete']);
  assert.deepEqual(full.slice(-2), ['/src/', '/dst/']);
});

test('parseArgs splits the command from its flags', () => {
  const o = parseArgs(['capture', 'my-world', '--data', '/d']);
  assert.equal(o.command, 'capture');
  assert.deepEqual(o.positional, ['my-world']);
  assert.equal(o.data, '/d');
  assert.equal(parseArgs(['provision', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['restore', '--yes']).yes, true);
  assert.equal(parseArgs(['snapshot', '--golden']).golden, true);
  assert.equal(parseArgs(['snapshot']).golden, undefined);
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

// ---------------------------------------------------------------------------
// world template
// ---------------------------------------------------------------------------

test('partitionSettings keeps preference, holds the module set, drops identity', () => {
  const rows = [
    { key: 'core.diceConfiguration', value: '{"d20":"foundry"}' },
    { key: 'dice-so-nice.settings', value: '{"scale":1}' },
    { key: 'core.moduleConfiguration', value: '{"dd-import":true}' },
    { key: 'core.activeScene', value: 'abc123' },
    { key: 'core.compendiumConfiguration', value: '{}' },
  ];
  const { kept, regenerated, dropped } = partitionSettings(rows);

  // Preference travels to a new world.
  assert.deepEqual(
    kept.map(r => r.key),
    ['core.diceConfiguration', 'dice-so-nice.settings'],
  );
  // The enabled set follows the pins, not one world's history.
  assert.deepEqual(
    regenerated.map(r => r.key),
    ['core.moduleConfiguration'],
  );
  // Identity would carry a reference to documents the new world does not have.
  assert.deepEqual(
    dropped.map(r => r.key),
    ['core.activeScene', 'core.compendiumConfiguration'],
  );
});

test('partitionSettings keeps unknown module settings rather than guessing', () => {
  // The blacklist is deliberate: a whitelist would silently drop settings from
  // any module installed after it was written, and you would believe you were
  // configured when you were not.
  const { kept } = partitionSettings([
    { key: 'some-module-released-next-year.opts', value: '{"a":1}' },
  ]);
  assert.deepEqual(
    kept.map(r => r.key),
    ['some-module-released-next-year.opts'],
  );
});

test('partitionSettings ignores malformed rows instead of throwing', () => {
  const { kept, dropped, regenerated } = partitionSettings([null, {}, { key: 42 }, undefined]);
  assert.deepEqual([kept, regenerated, dropped], [[], [], []]);
  assert.deepEqual(partitionSettings(undefined).kept, []);
});

test('worldShape strips the identity and keeps everything else', () => {
  const shape = worldShape({
    id: 'old-world',
    title: 'Old World',
    description: 'notes',
    lastPlayed: '2026-01-01',
    system: 'dnd5e',
    coreVersion: '14.364',
    systemVersion: '5.3.3',
    somethingFoundryAddedLater: true,
  });
  assert.deepEqual(shape, {
    system: 'dnd5e',
    coreVersion: '14.364',
    systemVersion: '5.3.3',
    // Unknown fields survive: the shape is captured, never authored, because
    // world.json gains and loses fields between Foundry versions.
    somethingFoundryAddedLater: true,
  });
  assert.deepEqual(worldShape(undefined), {});
});

test('captureWorld reads a real world directory end to end', async () => {
  // A real LevelDB, not a mock: there is no second Foundry to rehearse on
  // (one licence, one active server), so the write path this feeds must be
  // exercised against the actual store format.
  const { ClassicLevel } = await import('classic-level');
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-'));
  try {
    const worldDir = path.join(data, 'Data', 'worlds', 'zzz-source');
    await mkdir(path.join(worldDir, 'data'), { recursive: true });
    await writeFile(
      path.join(worldDir, 'world.json'),
      JSON.stringify({
        id: 'zzz-source',
        title: 'Source World',
        system: 'dnd5e',
        coreVersion: '14.364',
        systemVersion: '5.3.3',
      }),
    );

    const db = new ClassicLevel(path.join(worldDir, 'data', 'settings'), {
      valueEncoding: 'json',
    });
    await db.open();
    await db.put('a', { key: 'core.diceConfiguration', value: '{"d20":"foundry"}' });
    await db.put('b', { key: 'core.moduleConfiguration', value: '{"dd-import":true}' });
    await db.put('c', { key: 'core.activeScene', value: 'sceneid' });
    await db.put('d', {
      key: 'ddb-importer.cobalt-cookie',
      value: 'FIXTURE-NOT-A-REAL-COOKIE-E2E',
    });
    await db.close();

    const template = await captureWorld('zzz-source', { data });

    assert.equal(template.capturedFrom, 'zzz-source');
    // Recorded so new-world can refuse a template captured under another
    // Foundry version rather than writing a world that half-works.
    assert.equal(template.coreVersion, '14.364');
    assert.equal(template.system, 'dnd5e');
    assert.ok(!('id' in template.worldShape), 'the shape must not carry the old id');
    assert.ok(!('title' in template.worldShape), 'the shape must not carry the old title');
    assert.deepEqual(
      template.settings.map(r => r.key),
      ['core.diceConfiguration'],
    );
    assert.deepEqual(template.droppedAsIdentity, ['core.activeScene']);
    assert.deepEqual(
      template.regeneratedAtCapture.map(r => r.key),
      ['core.moduleConfiguration'],
    );
    // The credential is named but never carried — the template file is meant to
    // be read, diffed and handed around, and this one is a live session cookie.
    assert.deepEqual(template.redactedAsSecret, ['ddb-importer.cobalt-cookie']);
    assert.ok(
      !JSON.stringify(template).includes('FIXTURE-NOT-A-REAL-COOKIE-E2E'),
      'no part of the template may carry the credential value',
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('captureWorld names the available worlds when the id is wrong', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-'));
  try {
    await mkdir(path.join(data, 'Data', 'worlds', 'real-world'), { recursive: true });
    await assert.rejects(() => captureWorld('typo', { data }), /Available: real-world/);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('every identity setting is a core key, so a module can never be dropped', () => {
  // A module's settings are namespaced by its id. If a blacklist entry were not
  // core.*, a future module could collide with it and lose its configuration
  // silently on every new world.
  for (const key of IDENTITY_SETTINGS) {
    assert.ok(key.startsWith('core.'), `${key} must be a core setting`);
  }
});

// ---------------------------------------------------------------------------
// installEntry — provision has to work on a data dir Foundry never started in
// ---------------------------------------------------------------------------

const ENTRY = {
  id: 'dice-so-nice',
  kind: 'modules',
  version: '5.1.4',
  manifest: 'https://example.invalid/module.json',
};

/** Minimal stand-in for the two fetches installEntry makes. */
function fakeFetch({
  manifest = { download: 'https://example.invalid/module.zip' },
  bytes = 'ZIPBYTES',
  downloadOk = true,
  manifestOk = true,
} = {}) {
  const calls = [];
  const impl = async url => {
    calls.push(url);
    if (url === ENTRY.manifest) {
      return { ok: manifestOk, status: manifestOk ? 200 : 404, json: async () => manifest };
    }
    return {
      ok: downloadOk,
      status: downloadOk ? 200 : 403,
      arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
    };
  };
  impl.calls = calls;
  return impl;
}

test('installEntry works against a data dir Foundry has never started in', async () => {
  // The regression this exists for: a rebuilt volume has no Data/ at all, and
  // writing the zip before creating the destination died with a bare ENOENT
  // *after* the download had been paid for.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-fresh-'));
  try {
    const unpacked = [];
    const dest = await installEntry(ENTRY, data, {
      fetch: fakeFetch(),
      unpack: async (zip, target) => {
        // The zip must exist by the time the unpacker runs.
        assert.equal(await readFile(zip, 'utf8'), 'ZIPBYTES');
        unpacked.push([zip, target]);
      },
    });

    assert.equal(dest, path.join(data, 'Data', 'modules', 'dice-so-nice'));
    await access(dest);
    assert.equal(unpacked.length, 1);
    assert.equal(unpacked[0][1], dest);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry removes the downloaded zip, even when unpacking fails', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-fresh-'));
  try {
    let zipPath;
    await assert.rejects(
      () =>
        installEntry(ENTRY, data, {
          fetch: fakeFetch(),
          unpack: async zip => {
            zipPath = zip;
            throw new Error('unzip exited 9');
          },
        }),
      /unzip exited 9/,
    );
    // A half-downloaded archive left in Data/ would be picked up by the next
    // snapshot and shipped into the golden image.
    await assert.rejects(() => access(zipPath), { code: 'ENOENT' });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry reports a failed download rather than unzipping an error page', async () => {
  // An expired or redirected link answers 403 with HTML. Writing that as the
  // zip fails later as "not a zipfile", which describes the wrong problem.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-fresh-'));
  try {
    await assert.rejects(
      () =>
        installEntry(ENTRY, data, {
          fetch: fakeFetch({ downloadOk: false }),
          unpack: async () => assert.fail('must not unpack a failed download'),
        }),
      /dice-so-nice: download failed \(403\)/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry refuses a manifest with no download URL before touching disk', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-fresh-'));
  try {
    await assert.rejects(
      () =>
        installEntry(ENTRY, data, {
          fetch: fakeFetch({ manifest: { id: 'dice-so-nice' } }),
          unpack: async () => assert.fail('must not unpack'),
        }),
      /manifest has no download URL/,
    );
    await assert.rejects(() => access(path.join(data, 'Data')), { code: 'ENOENT' });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// verify — the drill's success check, as an exit code
// ---------------------------------------------------------------------------

const PINS = {
  system: { id: 'dnd5e', version: '5.3.3' },
  core: [
    { id: 'lib-wrapper', version: '1.13.5.1' },
    { id: 'socketlib', version: 'v1.1.4' },
    { id: 'enhancedcombathud', version: '0.5.0' },
  ],
};

const levels = rows => rows.map(r => `${r.level} ${r.id}`);

test('verifyPins reports each pin as installed, drifted, or missing', () => {
  const rows = verifyPins(
    PINS,
    new Map([
      ['dnd5e', { version: '5.3.3' }],
      ['lib-wrapper', { version: '1.13.4' }],
      ['socketlib', { version: 'v1.1.4' }],
    ]),
  );
  assert.deepEqual(levels(rows), [
    'ok dnd5e',
    'fail lib-wrapper',
    'ok socketlib',
    'fail enhancedcombathud',
  ]);
  assert.match(rows[1].text, /installed 1\.13\.4, pinned 1\.13\.5\.1/);
  assert.match(rows[3].text, /not installed \(pinned 0\.5\.0\)/);
});

test('verifyPins compares versions exactly, the way provision does', () => {
  // socketlib's pin is the literal "v1.1.4" because that is what its own
  // module.json says. Normalising the "v" away here would report ok on an
  // install that provision reinstalls on every run — the two commands have to
  // mean the same thing by "installed".
  const rows = verifyPins(PINS, new Map([['socketlib', { version: '1.1.4' }]]));
  const socketlib = rows.find(r => r.id === 'socketlib');
  assert.equal(socketlib.level, 'fail');
});

test('requiredIds reads both the modern and the legacy dependency shape', () => {
  assert.deepEqual(
    requiredIds({ relationships: { requires: [{ id: 'lib-wrapper' }, { id: 'socketlib' }] } }),
    ['lib-wrapper', 'socketlib'],
  );
  // Pre-v10 modules, still in the wild among long-unreleased pins.
  assert.deepEqual(requiredIds({ dependencies: [{ name: 'lib-wrapper' }] }), ['lib-wrapper']);
  assert.deepEqual(requiredIds({}), []);
});

test('requiredIds ignores compatibility statements about the system', () => {
  // relationships.systems says "I work with dnd5e", not "install dnd5e".
  assert.deepEqual(
    requiredIds({
      relationships: { systems: [{ id: 'dnd5e' }], requires: [{ id: 'lib-wrapper' }] },
    }),
    ['lib-wrapper'],
  );
  assert.deepEqual(requiredIds({ dependencies: [{ name: 'dnd5e', type: 'system' }] }), []);
});

test('verifyDependencies fails on a requirement that is not pinned', () => {
  const rows = verifyDependencies(
    new Map([
      ['enhancedcombathud', { relationships: { requires: [{ id: 'socketlib' }] } }],
      ['socketlib', {}],
    ]),
    ['enhancedcombathud', 'socketlib'],
  );
  assert.deepEqual(rows, []);

  const open = verifyDependencies(
    new Map([['enhancedcombathud', { relationships: { requires: [{ id: 'colorsettings' }] } }]]),
    ['enhancedcombathud'],
  );
  assert.deepEqual(levels(open), ['fail enhancedcombathud']);
  assert.match(open[0].text, /requires colorsettings, which is not pinned/);
});

test('verifyDependencies ignores what an unpinned module wants', () => {
  // provision only installs the pinned set, so only the pinned set has to be
  // closed. A module someone installed by hand can want anything.
  const rows = verifyDependencies(
    new Map([['some-hand-install', { relationships: { requires: [{ id: 'nothing-pinned' }] } }]]),
    ['lib-wrapper'],
  );
  assert.deepEqual(rows, []);
});

test('verifyWorldModules fails a pinned module the world has switched off', () => {
  const rows = verifyWorldModules({ 'lib-wrapper': false, socketlib: true }, [
    'lib-wrapper',
    'socketlib',
  ]);
  assert.deepEqual(levels(rows), ['fail lib-wrapper']);
});

test('verifyWorldModules warns rather than fails on a module outside core', () => {
  // A game's own content module is enabled in its world and has no business in
  // the golden base — routine, so it must not fail the gate. It still gets said
  // out loud, because it is how you learn a module will not survive a rebuild.
  const rows = verifyWorldModules({ socketlib: true, 'lure-of-the-lamia': true }, ['socketlib']);
  assert.deepEqual(levels(rows), ['warn lure-of-the-lamia']);
  assert.match(rows[0].text, /a rebuild will not bring it back/);
});

test('verifyWorldSystem fails on the wrong system, warns on a lagging version', () => {
  const wrong = verifyWorldSystem({ system: 'pf2e' }, PINS.system);
  assert.deepEqual(levels(wrong), ['fail system']);

  // world.json records the version the world last LAUNCHED under, so it lags a
  // fresh provision until the world is opened once. Failing on something that
  // fixes itself on launch is how a gate gets ignored.
  const lagging = verifyWorldSystem({ system: 'dnd5e', systemVersion: '5.3.2' }, PINS.system);
  assert.deepEqual(levels(lagging), ['warn system']);
  assert.match(lagging[0].text, /launch it once to migrate/);

  assert.deepEqual(verifyWorldSystem({ system: 'dnd5e', systemVersion: '5.3.3' }, PINS.system), []);
});

// ---------------------------------------------------------------------------
// redactSecrets — a template is passed around; a credential in it travels too
// ---------------------------------------------------------------------------

const keysOf = rows => rows.map(r => r.key);

test('redactSecrets drops credential rows and names them', () => {
  // Fixture values are deliberately shaped like nothing real: no JWT prefix, no
  // `sk-live-` stub, nothing a scanner or a reader should have to think twice
  // about. Only the KEYS matter to this code, and a repo whose subject is not
  // leaking credentials should not carry decorative look-alikes of them.
  const { kept, redacted } = redactSecrets([
    { key: 'ddb-importer.cobalt-cookie', value: 'FIXTURE-NOT-A-REAL-COOKIE' },
    { key: 'core.diceConfiguration', value: '{}' },
    { key: 'some-module.apiKey', value: 'FIXTURE-NOT-A-REAL-KEY' },
    { key: 'other.password', value: 'FIXTURE-NOT-A-REAL-PASSWORD' },
  ]);
  assert.deepEqual(keysOf(kept), ['core.diceConfiguration']);
  assert.deepEqual(redacted, [
    'ddb-importer.cobalt-cookie',
    'some-module.apiKey',
    'other.password',
  ]);
  // Dropped, never blanked: an empty credential in a new world is
  // indistinguishable from a broken one, while an absent one prompts for itself.
  assert.ok(!JSON.stringify(kept).includes('FIXTURE-NOT-A-REAL-PASSWORD'));
});

test('redactSecrets never matches "token" on its own — this is a VTT', () => {
  // Foundry is full of tokens that are creatures on a map. Matching the bare
  // word would silently drop real configuration, which is the same failure a
  // settings whitelist would have had: believing you are configured when you
  // are not.
  const rows = [
    { key: 'core.defaultToken' },
    { key: 'token-action-hud.style' },
    { key: 'tokenmagic.autoTemplateSettings' },
    { key: 'combat-tracker-dock.tokenSize' },
  ];
  const { kept, redacted } = redactSecrets(rows);
  assert.deepEqual(redacted, []);
  assert.equal(kept.length, rows.length);

  // Compounds still do match.
  assert.deepEqual(redactSecrets([{ key: 'x.accessToken' }, { key: 'y.api_token' }]).redacted, [
    'x.accessToken',
    'y.api_token',
  ]);
});

test('redactSecrets never matches "auth" on its own — it is inside "author"', () => {
  assert.deepEqual(redactSecrets([{ key: 'some-module.authorName' }]).redacted, []);
  assert.deepEqual(redactSecrets([{ key: 'some-module.oauthState' }]).redacted, [
    'some-module.oauthState',
  ]);
});

test('redactSecrets tolerates malformed rows rather than throwing', () => {
  const { kept, redacted } = redactSecrets([null, { value: 'x' }, { key: 42 }, { key: 'a.b' }]);
  assert.deepEqual(redacted, []);
  assert.equal(kept.length, 4);
});

test('the secret pattern is case-insensitive, since key casing is module choice', () => {
  assert.ok(SECRET_KEY_PATTERN.test('module.CobaltCookie'));
  assert.ok(SECRET_KEY_PATTERN.test('module.API_KEY'));
});
