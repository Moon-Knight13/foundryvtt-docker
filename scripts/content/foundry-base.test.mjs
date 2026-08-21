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
  installedVersion,
  manifestJson,
  requiredIds,
  verifyPins,
  verifyDependencies,
  verifyWorldModules,
  verifyWorldSystem,
  redactSecrets,
  dropWorldScopedPackRefs,
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
  dropExclusion,
  assertValidWorldId,
  settingsDbKey,
  documentId,
  newWorldJson,
  moduleConfigurationFor,
  settingsToWrite,
  freshRow,
  main,
  WORLD_IDENTITY_FIELDS,
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
    await db.put('e', {
      key: 'ddb-importer.entity-spell-compendium',
      value: '"world.ddb-zzz-source-ddb-spells"',
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
    // The pack id belongs to the world that made it. Carried into a new world
    // it names a pack that does not exist there.
    assert.deepEqual(template.droppedAsWorldPack, ['ddb-importer.entity-spell-compendium']);
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
        // A real unpack leaves a manifest behind; installEntry now refuses a
        // payload without one rather than reporting a silent half-install.
        await writeFile(
          path.join(target, 'module.json'),
          JSON.stringify({ id: 'dice-so-nice', version: '5.1.4' }),
        );
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

test('installEntry flattens a release zip that wraps everything in a folder', async () => {
  // Found by the first end-to-end rebuild drill. Seven of twenty-five pins
  // unzipped to Data/modules/<id>/<id>-<version>/module.json — one level too
  // deep for Foundry AND for `verify`, which reported them "not installed"
  // while provision reported success. Nothing threw, because nothing failed:
  // the payload was on disk, just not where a module lives.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-wrap-'));
  try {
    const dest = await installEntry(ENTRY, data, {
      fetch: fakeFetch(),
      unpack: async (_zip, target) => {
        const wrapped = path.join(target, 'dice-so-nice-5.1.4');
        await mkdir(path.join(wrapped, 'scripts'), { recursive: true });
        await writeFile(
          path.join(wrapped, 'module.json'),
          JSON.stringify({ id: 'dice-so-nice', version: '5.1.4' }),
        );
        await writeFile(path.join(wrapped, 'scripts', 'main.js'), '// code');
      },
    });

    // The manifest has to sit at the module root, and the rest travels with it.
    assert.equal(
      JSON.parse(await readFile(path.join(dest, 'module.json'), 'utf8')).version,
      '5.1.4',
    );
    assert.equal(await readFile(path.join(dest, 'scripts', 'main.js'), 'utf8'), '// code');
    // The wrapper is gone rather than left beside its own contents.
    await assert.rejects(() => access(path.join(dest, 'dice-so-nice-5.1.4')), { code: 'ENOENT' });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry leaves an already-flat release zip alone', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-flat-'));
  try {
    const dest = await installEntry(ENTRY, data, {
      fetch: fakeFetch(),
      unpack: async (_zip, target) => {
        await mkdir(path.join(target, 'styles'), { recursive: true });
        await writeFile(
          path.join(target, 'module.json'),
          JSON.stringify({ id: 'dice-so-nice', version: '5.1.4' }),
        );
        await writeFile(path.join(target, 'styles', 'x.css'), 'body{}');
      },
    });
    assert.equal(
      JSON.parse(await readFile(path.join(dest, 'module.json'), 'utf8')).version,
      '5.1.4',
    );
    assert.equal(await readFile(path.join(dest, 'styles', 'x.css'), 'utf8'), 'body{}');
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry says so when the payload holds no manifest at all', async () => {
  // Silence is the failure mode this whole fix exists to end: a module that is
  // on disk but invisible looks identical to one that was never installed,
  // and only `verify` catches it, much later.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-nomanifest-'));
  try {
    await assert.rejects(
      () =>
        installEntry(ENTRY, data, {
          fetch: fakeFetch(),
          unpack: async (_zip, target) => {
            await mkdir(path.join(target, 'docs'), { recursive: true });
            await writeFile(path.join(target, 'docs', 'README.md'), '# nothing useful');
          },
        }),
      /dice-so-nice: no module\.json/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installedVersion reads what is actually on disk, not what was pinned', async () => {
  // The pin is a record, not a constraint: most manifest URLs resolve to
  // /latest/, so provision installs whatever is current and must report the
  // version it really put down.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-ver-'));
  try {
    const dest = path.join(data, 'Data', 'modules', 'dice-so-nice');
    await mkdir(dest, { recursive: true });
    await writeFile(path.join(dest, 'module.json'), JSON.stringify({ version: '6.2.9' }));
    assert.equal(await installedVersion(data, ENTRY), '6.2.9');
    // Absent and malformed both mean "nothing usable here", not a throw.
    assert.equal(await installedVersion(data, { ...ENTRY, id: 'absent' }), null);
    await writeFile(path.join(dest, 'module.json'), 'not json');
    assert.equal(await installedVersion(data, ENTRY), null);
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

test('verifyWorldModules names a deliberate exclusion instead of repeating itself', () => {
  // deliberatelyExcluded is someone having written down WHY a module is out.
  // Answering that with the generic warning every run is how a report teaches
  // people to skim it.
  const rows = verifyWorldModules({ 'scene-packer': true }, [], {
    'scene-packer': 'Overlaps what the compendium pipeline already does.',
  });
  assert.deepEqual(levels(rows), ['warn scene-packer']);
  assert.match(rows[0].text, /deliberately excluded from core: Overlaps what/);
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

test('redactSecrets never matches "secret" on its own — secret doors and rolls', () => {
  // Both keys are real, from a capture of a live world. They were dropped by
  // the first version of this pattern: secret ROLLS and secret DOORS, plain
  // preferences, gone silently. A credential that slips through is visible in
  // the printed key list; a preference that gets eaten is not — so when in
  // doubt, do not match.
  // gitleaks fires generic-api-key on the first of these, which is the same
  // over-match this test exists to prevent — a scanner reading "Secret" in a
  // dice preference. Allowed inline rather than by widening a rule.
  const rows = [
    { key: 'dice-so-nice.hide3dDiceOnSecretRolls' }, // gitleaks:allow
    { key: 'monks-wall-enhancement.toggle-secret' }, // gitleaks:allow
  ];
  const { kept, redacted } = redactSecrets(rows);
  assert.deepEqual(redacted, []);
  assert.equal(kept.length, 2);

  // Compounds that really are credentials still match.
  assert.deepEqual(
    redactSecrets([{ key: 'x.clientSecret' }, { key: 'y.secret_key' }, { key: 'z.api-secret' }])
      .redacted,
    ['x.clientSecret', 'y.secret_key', 'z.api-secret'],
  );
});

test('redactSecrets leaves licence keys alone — they are not world settings', () => {
  // Nothing puts a Foundry licence key in a world's settings, while a
  // "show licence info" toggle is entirely plausible.
  assert.deepEqual(redactSecrets([{ key: 'some-module.showLicense' }]).redacted, []);
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

// ---------------------------------------------------------------------------
// dropWorldScopedPackRefs — a setting whose VALUE names another world's pack
// ---------------------------------------------------------------------------

test('dropWorldScopedPackRefs drops a setting pointing at a world-scoped pack', () => {
  // Captured from a real world: ddb-importer files its twelve packs under the
  // world that made them, and stores the pack id as a preference. Cloned into a
  // new world, every one of those is a pointer to a pack that does not exist.
  const { kept, dropped } = dropWorldScopedPackRefs([
    { key: 'ddb-importer.entity-spell-compendium', value: '"world.ddb-old-world-ddb-spells"' },
    { key: 'ddb-importer.entity-monster-compendium', value: '"world.ddb-old-world-ddb-monsters"' },
    { key: 'core.diceConfiguration', value: '{"d20":"foundry"}' },
  ]);
  assert.deepEqual(
    kept.map(r => r.key),
    ['core.diceConfiguration'],
  );
  assert.deepEqual(dropped, [
    'ddb-importer.entity-spell-compendium',
    'ddb-importer.entity-monster-compendium',
  ]);
});

test('dropWorldScopedPackRefs keeps a pack id that belongs to a module', () => {
  // Module packs survive a world wipe — they live in the module folder. Only
  // the `world.` scope dies with the world, so only it is dropped.
  const { kept, dropped } = dropWorldScopedPackRefs([
    { key: 'some-module.defaultPack', value: '"dnd5e.monsters"' },
    { key: 'other.pack', value: '"my-game-oneshot.actors"' },
  ]);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 2);
});

test('dropWorldScopedPackRefs drops a list of world-scoped packs', () => {
  const { kept, dropped } = dropWorldScopedPackRefs([
    { key: 'multi-token-edit.hideManagedPacks', value: '["world.ddb-old-ddb-items"]' },
    { key: 'other.packs', value: '["dnd5e.items","world.ddb-old-ddb-spells"]' },
  ]);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped, ['multi-token-edit.hideManagedPacks', 'other.packs']);
});

test('dropWorldScopedPackRefs will not match prose that merely says "world."', () => {
  // Same rule as the secret word list: when in doubt, do not match. A dropped
  // preference is invisible, while a dead pack reference announces itself the
  // first time you open the module. Only a whole string shaped like a pack id.
  const { kept, dropped } = dropWorldScopedPackRefs([
    { key: 'module.welcome', value: '"Welcome to the world. Enjoy."' },
    { key: 'module.note', value: '"see world.md for setup"' },
    { key: 'module.flag', value: 'true' },
    { key: 'module.count', value: '3' },
  ]);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 4);
});

test('dropWorldScopedPackRefs tolerates malformed rows rather than throwing', () => {
  const { kept, dropped } = dropWorldScopedPackRefs([
    null,
    undefined,
    {},
    { key: 'x.y' },
    { key: 'a.b', value: '{not json' },
  ]);
  assert.deepEqual(dropped, []);
  // The three rows without a string key are not settings at all. The two that
  // are — one with no value, one whose value is not JSON — are kept: neither
  // can be read as a pack id, and dropping on unreadable is how configuration
  // goes missing quietly.
  assert.deepEqual(
    kept.map(r => r.key),
    ['x.y', 'a.b'],
  );
  assert.deepEqual(dropWorldScopedPackRefs(undefined).kept, []);
});

// ---------------------------------------------------------------------------
// dropExclusion — a manifest must not say both "pinned" and "kept out, because"
// ---------------------------------------------------------------------------

test('dropExclusion returns the reason it overruled and removes the entry', () => {
  const manifest = {
    core: [],
    deliberatelyExcluded: {
      'scene-packer': 'Overlaps what the compendium pipeline already does.',
      'fa-battlemaps': 'Large art asset pack; would bloat every snapshot.',
    },
  };
  assert.equal(
    dropExclusion(manifest, 'scene-packer'),
    'Overlaps what the compendium pipeline already does.',
  );
  assert.deepEqual(Object.keys(manifest.deliberatelyExcluded), ['fa-battlemaps']);
});

test('dropExclusion is a no-op for a module that was never excluded', () => {
  const manifest = { deliberatelyExcluded: { 'fa-battlemaps': 'reason' } };
  assert.equal(dropExclusion(manifest, 'lib-wrapper'), null);
  assert.deepEqual(Object.keys(manifest.deliberatelyExcluded), ['fa-battlemaps']);
  // Manifests written before deliberatelyExcluded existed must not throw.
  assert.equal(dropExclusion({}, 'anything'), null);
});

test('dropExclusion distinguishes an empty reason from no exclusion at all', () => {
  // An empty string is still a recorded decision; returning null for it would
  // silently skip the "this overrules something" message.
  const manifest = { deliberatelyExcluded: { x: '' } };
  assert.equal(dropExclusion(manifest, 'x'), '');
  assert.deepEqual(manifest.deliberatelyExcluded, {});
});

// ---------------------------------------------------------------------------
// new-world — apply the captured template to a world that has never existed
// ---------------------------------------------------------------------------

const TEMPLATE = {
  capturedFrom: 'source-world',
  coreVersion: '14.364',
  system: 'dnd5e',
  systemVersion: '5.3.3',
  worldShape: {
    system: 'dnd5e',
    coreVersion: '14.364',
    systemVersion: '5.3.3',
    compatibility: { minimum: '14' },
    flags: { 'some-module': { seen: true } },
  },
  settings: [
    {
      key: 'core.diceConfiguration',
      user: null,
      value: '{}',
      _id: 'OLDIDOLDIDOLDID1',
      _stats: { lastModifiedBy: 'someuserid00000' },
    },
  ],
  regeneratedAtCapture: [
    {
      key: 'core.moduleConfiguration',
      user: null,
      value: '{"old":true}',
      _id: 'OLDIDOLDIDOLDID2',
      _stats: {},
    },
  ],
};

const NEW_WORLD_PINS = { core: [{ id: 'lib-wrapper' }, { id: 'socketlib' }] };

test('settingsDbKey uses the prefix Foundry actually uses', () => {
  // Read off a live world, not assumed. A bare id writes rows the server never
  // looks at, which fails as an empty settings screen rather than as an error —
  // the worst kind of wrong, because it looks like the capture was empty.
  assert.equal(settingsDbKey('09v0Fjkkjc4qEI2o'), '!settings!09v0Fjkkjc4qEI2o');
});

test('documentId looks like a Foundry document id', () => {
  const id = documentId();
  assert.match(id, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(documentId(), documentId());
});

test('documentId draws in range instead of taking a byte modulo 62', () => {
  // The first version did `randomByte % 62`, which biases: 256 is not a
  // multiple of 62, so the first eight letters would come up five times per 256
  // draws and the rest four. randomInt rejection-samples, so the drawn value is
  // used unmodified — that is what this pins.
  const asked = [];
  const id = documentId(max => {
    asked.push(max);
    return 61;
  });
  assert.equal(id, '9999999999999999', 'index 61 is the last character of the alphabet');
  assert.deepEqual([...new Set(asked)], [62], 'always asks across the whole alphabet');
  assert.equal(asked.length, 16);
});

test('assertValidWorldId refuses ids that would be awkward forever', () => {
  assert.equal(assertValidWorldId('winters-teeth'), 'winters-teeth');
  for (const bad of ['Winters Teeth', 'winters_teeth', '-leading', '../escape', '']) {
    assert.throws(() => assertValidWorldId(bad), /world id|needs a world id/i);
  }
});

test('newWorldJson copies the captured shape and puts identity back', () => {
  const world = newWorldJson(TEMPLATE, { id: 'winters-teeth', title: "Winter's Teeth" });
  assert.equal(world.id, 'winters-teeth');
  assert.equal(world.title, "Winter's Teeth");
  // Fields this tool has never heard of travel unread — the whole reason the
  // shape is captured rather than composed.
  assert.deepEqual(world.compatibility, { minimum: '14' });
  assert.deepEqual(world.flags, { 'some-module': { seen: true } });
  assert.equal(world.coreVersion, '14.364');
});

test('newWorldJson demands the two things Foundry cannot invent', () => {
  assert.throws(() => newWorldJson(TEMPLATE, { id: 'x' }), /--title/);
  assert.throws(() => newWorldJson(TEMPLATE, { title: 'T' }), /needs a world id/);
  assert.throws(() => newWorldJson({}, { id: 'x', title: 'T' }), /world-capture/);
});

test('newWorldJson lets the operator override system and core version', () => {
  const world = newWorldJson(TEMPLATE, {
    id: 'x',
    title: 'T',
    system: 'cairn',
    coreVersion: '15.1',
  });
  assert.equal(world.system, 'cairn');
  assert.equal(world.coreVersion, '15.1');
});

test("packs is treated as identity — it names the old world's own compendia", () => {
  // For this table that is ddb-importer's twelve world-scoped world.ddb-* packs,
  // which die with the world that made them. Copying the list into a new world
  // declares packs that do not exist.
  assert.ok(WORLD_IDENTITY_FIELDS.includes('packs'));
  assert.ok(
    !('packs' in worldShape({ id: 'x', packs: [{ name: 'ddb-spells' }], system: 'dnd5e' })),
  );
});

test('moduleConfigurationFor follows the pins, not the source world', () => {
  assert.deepEqual(moduleConfigurationFor(NEW_WORLD_PINS), {
    'lib-wrapper': true,
    socketlib: true,
  });
  assert.deepEqual(moduleConfigurationFor({}), {});
});

test('freshRow reissues the id and clears the user who last touched it', () => {
  const row = freshRow(TEMPLATE.settings[0], () => 'NEWIDNEWIDNEWID1');
  assert.equal(row._id, 'NEWIDNEWIDNEWID1');
  // That user account does not exist in a world that has never been opened.
  assert.equal(row._stats.lastModifiedBy, null);
  assert.equal(row.key, 'core.diceConfiguration');
  assert.equal(row.value, '{}');
});

test('settingsToWrite regenerates the module set and re-ids everything', () => {
  let n = 0;
  const rows = settingsToWrite(TEMPLATE, NEW_WORLD_PINS, {
    newId: () => `ID${String(n++).padStart(14, '0')}`,
  });
  assert.deepEqual(
    rows.map(r => r.key),
    ['core.diceConfiguration', 'core.moduleConfiguration'],
  );
  // The captured module set is discarded; the pins win.
  assert.deepEqual(JSON.parse(rows[1].value), { 'lib-wrapper': true, socketlib: true });
  // ...but the captured row's other fields are kept, so anything Foundry
  // expects on a settings document still travels.
  assert.equal(rows[1].user, null);
  assert.ok('_stats' in rows[1]);
  assert.equal(new Set(rows.map(r => r._id)).size, 2, 'every row gets its own fresh id');
});

test('settingsToWrite still writes a module configuration when none was captured', () => {
  const rows = settingsToWrite({ settings: [] }, NEW_WORLD_PINS);
  assert.deepEqual(
    rows.map(r => r.key),
    ['core.moduleConfiguration'],
  );
});

test('partitionSettings sets aside rows belonging to one specific user', () => {
  // A settings row with a `user` is one player's own preference. A new world
  // has no such account, so it would be a dead reference on arrival.
  const { kept, userScoped } = partitionSettings([
    { key: 'a.pref', user: null },
    { key: 'b.pref' },
    { key: 'c.pref', user: 'aUserDocumentId0' },
  ]);
  assert.deepEqual(
    kept.map(r => r.key),
    ['a.pref', 'b.pref'],
  );
  assert.deepEqual(
    userScoped.map(r => r.key),
    ['c.pref'],
  );
});

test('new-world writes a store that captureWorld reads straight back', async () => {
  // The strongest available proof, and the only one that matters: there is no
  // second Foundry to rehearse against (one licence, one active server), so the
  // write path is exercised against a real ClassicLevel store and then read by
  // the same code that reads Foundry's own.
  const { ClassicLevel } = await import('classic-level');
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-nw-'));
  const quiet = console.log;
  console.log = () => {};
  try {
    await mkdir(path.join(data, 'Data', 'worlds'), { recursive: true });
    const templatePath = path.join(data, 'template.json');
    await writeFile(templatePath, JSON.stringify(TEMPLATE));
    const manifestPath = path.join(data, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(NEW_WORLD_PINS));

    await main([
      'new-world',
      'winters-teeth',
      '--title',
      "Winter's Teeth",
      '--data',
      data,
      '--from',
      templatePath,
      '--manifest',
      manifestPath,
    ]);

    const worldDir = path.join(data, 'Data', 'worlds', 'winters-teeth');
    const world = JSON.parse(await readFile(path.join(worldDir, 'world.json'), 'utf8'));
    assert.equal(world.id, 'winters-teeth');
    assert.equal(world.title, "Winter's Teeth");
    assert.deepEqual(world.compatibility, { minimum: '14' });
    assert.ok(!('packs' in world), "must not declare the source world's compendia");

    // Keys carry Foundry's prefix; a bare id would be silently ignored.
    const db = new ClassicLevel(path.join(worldDir, 'data', 'settings'), { valueEncoding: 'json' });
    await db.open();
    const seen = [];
    for await (const [k, v] of db.iterator()) seen.push([k, v]);
    await db.close();
    assert.ok(seen.length >= 2);
    for (const [k, v] of seen) assert.equal(k, `!settings!${v._id}`);

    // And the round trip: the same reader Foundry's own settings go through.
    const back = await captureWorld('winters-teeth', { data });
    assert.deepEqual(
      back.settings.map(r => r.key),
      ['core.diceConfiguration'],
    );
    assert.deepEqual(
      back.regeneratedAtCapture.map(r => r.key),
      ['core.moduleConfiguration'],
    );
    assert.deepEqual(JSON.parse(back.regeneratedAtCapture[0].value), {
      'lib-wrapper': true,
      socketlib: true,
    });
  } finally {
    console.log = quiet;
    await rm(data, { recursive: true, force: true });
  }
});

test('new-world refuses to touch a world that already exists', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-nw-'));
  const quiet = console.log;
  console.log = () => {};
  try {
    await mkdir(path.join(data, 'Data', 'worlds', 'taken'), { recursive: true });
    const templatePath = path.join(data, 'template.json');
    await writeFile(templatePath, JSON.stringify(TEMPLATE));
    // A world is somebody's campaign. There is no --force for this.
    await assert.rejects(
      () => main(['new-world', 'taken', '--title', 'T', '--data', data, '--from', templatePath]),
      /already exists. Refusing to touch an existing world/,
    );
  } finally {
    console.log = quiet;
    await rm(data, { recursive: true, force: true });
  }
});

test('new-world says how to make a template when there is none', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-nw-'));
  try {
    await mkdir(path.join(data, 'Data', 'worlds'), { recursive: true });
    await assert.rejects(
      () =>
        main([
          'new-world',
          'x',
          '--title',
          'T',
          '--data',
          data,
          '--from',
          path.join(data, 'absent.json'),
        ]),
      /world-capture <that world>/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// manifestJson — write the encoding pre-commit expects, not a rival one
// ---------------------------------------------------------------------------

test('manifestJson escapes non-ASCII so pre-commit has nothing to fix', () => {
  // `update` used to write raw JSON.stringify while the repo's
  // pretty-format-json hook escapes non-ASCII. The two disagreed, so every pin
  // bump arrived buried in an em-dash diff across every note, and committing
  // triggered the autofix-and-abort that this repo already trips over.
  const out = manifestJson({ note: 'one fact — not two', title: 'Dice So Nice!' });
  assert.ok(out.includes('\\u2014'), 'the em dash must be escaped');
  assert.ok(!out.includes('—'), 'no raw non-ASCII may survive');
  // Still valid JSON, still the same data, still two-space indented with a
  // trailing newline.
  assert.deepEqual(JSON.parse(out), { note: 'one fact — not two', title: 'Dice So Nice!' });
  assert.ok(out.endsWith('}\n'));
  assert.ok(out.includes('\n  "note"'));
});

test('manifestJson leaves plain ASCII exactly as JSON.stringify would', () => {
  const value = { core: [{ id: 'dd-import', version: '6.1.1' }] };
  assert.equal(manifestJson(value), `${JSON.stringify(value, null, 2)}\n`);
});

test('installEntry prefers a pinned download URL over the manifest one', async () => {
  // A version-locked MANIFEST is not a version-locked module. The v0.8.2
  // manifest of foundry-mcp-bridge declares
  // download: .../releases/latest/download/foundry-vtt-mcp.zip — so provision
  // read "0.8.2" and installed 0.8.3. A pin may name its own download; when it
  // does, the manifest's is not consulted.
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-dl-'));
  try {
    const fetchImpl = fakeFetch();
    await installEntry({ ...ENTRY, download: 'https://example.invalid/v5.1.4/module.zip' }, data, {
      fetch: fetchImpl,
      unpack: async (_zip, target) => {
        await writeFile(
          path.join(target, 'module.json'),
          JSON.stringify({ id: 'dice-so-nice', version: '5.1.4' }),
        );
      },
    });
    assert.deepEqual(fetchImpl.calls, [
      ENTRY.manifest,
      'https://example.invalid/v5.1.4/module.zip',
    ]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('installEntry still follows the manifest when a pin names no download', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'fvtt-dl2-'));
  try {
    const fetchImpl = fakeFetch();
    await installEntry(ENTRY, data, {
      fetch: fetchImpl,
      unpack: async (_zip, target) => {
        await writeFile(
          path.join(target, 'module.json'),
          JSON.stringify({ id: 'dice-so-nice', version: '5.1.4' }),
        );
      },
    });
    assert.deepEqual(fetchImpl.calls, [ENTRY.manifest, 'https://example.invalid/module.zip']);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
