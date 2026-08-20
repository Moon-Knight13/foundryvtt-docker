#!/usr/bin/env node
// Golden base: make a Foundry install reproducible from a pinned manifest, so
// wiping a world is cheap and a rebuild lands on the same environment twice.
//
// Run on the HOST. It reads and writes the Foundry data directory, which the
// devcontainer does not mount, and `provision` needs network access.
//
// It lives under scripts/content/ because that is where this repo's Node
// tooling and its package.json live — `pull-games` calls straight into
// build.mjs — not because it is content tooling.
//
//   node scripts/content/foundry-base.mjs capture <world> [--data <path>]
//   node scripts/content/foundry-base.mjs world-capture <world> [--to <path>]
//   node scripts/content/foundry-base.mjs promote <capture.json>
//   node scripts/content/foundry-base.mjs provision [--dry-run]
//   node scripts/content/foundry-base.mjs update [id...]
//   node scripts/content/foundry-base.mjs snapshot [--golden] [--to <path>]
//   node scripts/content/foundry-base.mjs restore --yes [--golden] [--from <path>]
//   node scripts/content/foundry-base.mjs pull-games
//   node scripts/content/foundry-base.mjs verify [world]
//
// Why pinned: "always latest" is the documented hazard, not the goal — see
// docs/PROJECT.md on foundry-mcp module/server version drift. `update` is how
// you move, deliberately and in a reviewable commit.
//
// SECURITY: the data directory contains license.json and the admin key. This
// script never reads, parses or prints either. `snapshot` mirrors the directory
// wholesale with rsync, which necessarily includes them — so the snapshot path
// must live outside the repo tree and is refused if it does not.
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, access, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainLevelError } from './leveldb.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'foundry-base.json');
export const WORLD_TEMPLATE_FILE = 'foundry-world-template.json';

export function dataDir(explicit) {
  return (
    explicit ||
    process.env.FOUNDRY_DATA_PATH ||
    path.join(process.env.HOME ?? '', '.local', 'share', 'FoundryVTT')
  );
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Foundry stores a world's enabled modules under the `core.moduleConfiguration`
 * setting as {id: boolean}. Listing compendium packs is NOT a substitute: it
 * only reveals modules that ship packs, so every library and behaviour module
 * (lib-wrapper, socketlib, and most quality-of-life modules) is invisible that
 * way. This is the only complete source.
 */
export function enabledModules(moduleConfiguration) {
  if (!moduleConfiguration || typeof moduleConfiguration !== 'object') return [];
  return Object.entries(moduleConfiguration)
    .filter(([, on]) => on === true)
    .map(([id]) => id)
    .sort();
}

/** Pull the fields worth pinning out of an installed module.json. */
export function pinFromManifest(json, id) {
  return {
    id: json?.id ?? json?.name ?? id,
    version: json?.version ?? 'unknown',
    manifest: json?.manifest ?? '',
    title: json?.title ?? id,
  };
}

/** Read `core.moduleConfiguration` out of a world's LevelDB settings store. */
async function readModuleConfiguration(worldDir) {
  const { ClassicLevel } = await import('classic-level');
  const db = new ClassicLevel(path.join(worldDir, 'data', 'settings'), {
    valueEncoding: 'json',
  });
  try {
    await db.open();
    for await (const [, value] of db.iterator()) {
      if (value?.key === 'core.moduleConfiguration') {
        return typeof value.value === 'string' ? JSON.parse(value.value) : value.value;
      }
    }
    return null;
  } catch (err) {
    // A running Foundry holds this database open, and LevelDB is single-process.
    // The raw error is just "Database is not open", which says nothing useful.
    throw new Error(explainLevelError(err, `the settings for this world`));
  } finally {
    await db.close().catch(() => {});
  }
}

/**
 * Say why the data directory is missing rather than just that it is. Run inside
 * the devcontainer, every command here fails for one reason — the Foundry data
 * directory is deliberately not mounted — and a bare "not found" sends people
 * looking for a misspelled world instead.
 */
export async function assertDataDir(data) {
  const worldsDir = path.join(data, 'Data', 'worlds');
  try {
    await access(worldsDir);
  } catch {
    throw new Error(
      `No Foundry worlds at ${worldsDir}.\n` +
        (existsSync('/.dockerenv')
          ? '\nThis looks like a container. The Foundry data directory is not mounted\n' +
            'into the devcontainer by design — run this on the HOST instead.\n'
          : '') +
        `\nChecked FOUNDRY_DATA_PATH${process.env.FOUNDRY_DATA_PATH ? '' : ' (unset)'}` +
        `, resolved data dir: ${data}\n` +
        'Pass an explicit one with --data <path> if it lives elsewhere.',
    );
  }
  return worldsDir;
}

export async function capture(world, opts = {}) {
  const data = dataDir(opts.data);
  const worldsDir = await assertDataDir(data);
  const worldDir = path.join(worldsDir, world);
  await access(worldDir).catch(async () => {
    const available = await readdir(worldsDir).catch(() => []);
    throw new Error(
      `World "${world}" not found in ${worldsDir}.` +
        (available.length ? `\nAvailable: ${available.join(', ')}` : ''),
    );
  });

  const config = await readModuleConfiguration(worldDir);
  if (!config) {
    throw new Error(
      `No core.moduleConfiguration in ${world}. Launch the world once so Foundry writes it.`,
    );
  }

  const ids = enabledModules(config);
  const modules = [];
  const missing = [];
  for (const id of ids) {
    const manifestPath = path.join(data, 'Data', 'modules', id, 'module.json');
    try {
      modules.push(pinFromManifest(JSON.parse(await readFile(manifestPath, 'utf8')), id));
    } catch {
      // Enabled in the world but not installed on disk: real, and worth seeing.
      missing.push(id);
    }
  }

  let system = null;
  const worldJson = JSON.parse(await readFile(path.join(worldDir, 'world.json'), 'utf8'));
  if (worldJson.system) {
    const sysPath = path.join(data, 'Data', 'systems', worldJson.system, 'system.json');
    try {
      system = pinFromManifest(JSON.parse(await readFile(sysPath, 'utf8')), worldJson.system);
    } catch {
      system = {
        id: worldJson.system,
        version: 'unknown',
        manifest: '',
        title: worldJson.system,
      };
    }
  }

  return { world, system, modules, missing };
}

// ---------------------------------------------------------------------------
// world template
// ---------------------------------------------------------------------------

/**
 * Settings rows that describe *this* world rather than how you like Foundry set
 * up. Cloning them into a new world carries a reference to documents that world
 * does not have — a scene id that resolves to nothing, a compendium layout for
 * packs that are not installed.
 *
 * This is a blacklist, not a whitelist, and deliberately so: a whitelist drops
 * settings from modules installed after it was written, and the failure mode is
 * believing you are configured when you are not. Everything dropped is reported.
 */
export const IDENTITY_SETTINGS = [
  'core.activeScene',
  'core.compendiumConfiguration',
  'core.combatTrackerConfig',
  'core.time',
];

/**
 * Held out separately rather than dropped. The enabled module set should follow
 * the pins in foundry-base.json, not one world's history — so `new-world`
 * regenerates it. Keeping the captured copy visible makes the difference
 * auditable instead of silent.
 */
export const REGENERATED_SETTINGS = ['core.moduleConfiguration'];

/** world.json fields that name this particular world, not its shape. */
export const WORLD_IDENTITY_FIELDS = [
  'id',
  'name',
  'title',
  'description',
  'lastPlayed',
  'nextSession',
  'playtime',
];

/**
 * Split captured settings into what a new world should inherit, what is
 * regenerated from the pins, and what is this world's identity.
 */
export function partitionSettings(rows) {
  const kept = [];
  const regenerated = [];
  const dropped = [];
  for (const row of rows ?? []) {
    const key = row?.key;
    if (typeof key !== 'string') continue;
    if (REGENERATED_SETTINGS.includes(key)) regenerated.push(row);
    else if (IDENTITY_SETTINGS.includes(key)) dropped.push(row);
    else kept.push(row);
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  return {
    kept: kept.sort(byKey),
    regenerated: regenerated.sort(byKey),
    dropped: dropped.sort(byKey),
  };
}

/**
 * Strip the fields that name a world, keeping the shape.
 *
 * The shape is *captured, never authored*: Foundry's world.json gains and loses
 * fields between versions, and this repo already paid for guessing at Foundry's
 * own vocabulary once — six of eight hand-written module ids were wrong. Copying
 * a real manifest and substituting the identity is the only version-proof way to
 * write one.
 */
export function worldShape(worldJson) {
  const shape = {};
  for (const [k, v] of Object.entries(worldJson ?? {})) {
    if (!WORLD_IDENTITY_FIELDS.includes(k)) shape[k] = v;
  }
  return shape;
}

/** Read every settings row out of a world's LevelDB store. */
async function readAllSettings(worldDir) {
  const { ClassicLevel } = await import('classic-level');
  const db = new ClassicLevel(path.join(worldDir, 'data', 'settings'), {
    valueEncoding: 'json',
  });
  const rows = [];
  try {
    await db.open();
    for await (const [, value] of db.iterator()) {
      if (value && typeof value.key === 'string') rows.push(value);
    }
    return rows;
  } catch (err) {
    throw new Error(explainLevelError(err, 'the settings for this world'));
  } finally {
    await db.close().catch(() => {});
  }
}

/**
 * Record a world you have configured the way you want every future world to
 * start. Read-only with respect to the world.
 */
export async function captureWorld(world, opts = {}) {
  const data = dataDir(opts.data);
  const worldsDir = await assertDataDir(data);
  const worldDir = path.join(worldsDir, world);
  await access(worldDir).catch(async () => {
    const available = await readdir(worldsDir).catch(() => []);
    throw new Error(
      `World "${world}" not found in ${worldsDir}.` +
        (available.length ? `\nAvailable: ${available.join(', ')}` : ''),
    );
  });

  const worldJson = JSON.parse(await readFile(path.join(worldDir, 'world.json'), 'utf8'));
  const rows = await readAllSettings(worldDir);
  if (!rows.length) {
    throw new Error(
      `No settings in ${world}. Launch the world once and configure it before capturing.`,
    );
  }
  const { kept, regenerated, dropped } = partitionSettings(rows);

  return {
    capturedFrom: world,
    // A template captured under one Foundry version is not known to apply
    // cleanly under another; new-world compares this and refuses on a mismatch
    // rather than writing a world that half-works.
    coreVersion: worldJson.coreVersion ?? null,
    system: worldJson.system ?? null,
    systemVersion: worldJson.systemVersion ?? null,
    worldShape: worldShape(worldJson),
    settings: kept,
    regeneratedAtCapture: regenerated,
    droppedAsIdentity: dropped.map(r => r.key),
  };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export async function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${manifestPath}: ${err.message}. Run \`capture <world>\` first.`);
  }
}

/**
 * Merge a capture into an existing manifest.
 *
 * Core membership is a human decision, so a captured module that is not already
 * in core is reported, never silently promoted. Dropping one silently is how a
 * rebuild quietly loses `monks-active-tiles` and every scene built on it.
 */
export function mergeCapture(manifest, captured) {
  const coreIds = new Set((manifest.core ?? []).map(m => m.id));
  const core = (manifest.core ?? []).map(pin => {
    const fresh = captured.modules.find(m => m.id === pin.id);
    // A placeholder manifest ("TODO") must be overwritten, not preserved:
    // `pin.manifest || fresh.manifest` kept the placeholder, because "TODO" is
    // truthy. Only a real URL counts as something worth keeping.
    return fresh
      ? {
          ...pin,
          version: fresh.version,
          manifest: isInstallable(pin) ? pin.manifest : fresh.manifest || pin.manifest,
        }
      : pin;
  });
  const notInCore = captured.modules.filter(m => !coreIds.has(m.id));
  const inCoreNotEnabled = core.filter(m => !captured.modules.some(c => c.id === m.id));
  return { core, notInCore, inCoreNotEnabled };
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/**
 * Refuse a snapshot path inside the repo. The data directory contains
 * license.json and the admin key; a snapshot under the repo tree is one
 * `git add -A` away from committing a licence key.
 */
export function assertOutsideRepo(target) {
  const resolved = path.resolve(target);
  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(
      `Refusing to snapshot into the repo tree (${resolved}). The Foundry data ` +
        'directory contains license.json and the admin key. Choose a path outside the repo.',
    );
  }
  return resolved;
}

/**
 * The vault is bind-mounted *inside* the Foundry data root at Data/DnD. On the
 * host that path is an empty mount point, so excluding it changes nothing
 * today — but run either command from anywhere the vault is actually mounted
 * and it would copy the whole vault (1.6 GB and climbing) into every snapshot.
 */
export const VAULT_MOUNT = 'Data/DnD';
export const WORLDS_DIR = 'Data/worlds';

/**
 * Two modes, because "golden image" and "backup" are different jobs that were
 * previously the same command:
 *
 *   full   - everything, worlds included. The undo before a risky change, the
 *            campaign safety net, the thing you take before burning volumes.
 *   golden - systems, modules, config and assets. No worlds. A clean slate you
 *            can restore onto without losing the worlds you are keeping.
 *
 * The excludes matter as much on restore as on snapshot. rsync --delete removes
 * receiver files that are absent from the source, but files matched by
 * --exclude are protected from that deletion. Without these, `restore --golden`
 * would delete every live world - the exact opposite of what it promises.
 */
export function syncExcludes({ golden = false } = {}) {
  const excludes = [`/${VAULT_MOUNT}/`];
  if (golden) excludes.push(`/${WORLDS_DIR}/`);
  return excludes;
}

export function rsyncArgs(source, target, { golden = false } = {}) {
  const args = ['-a', '--delete'];
  for (const exclude of syncExcludes({ golden })) args.push('--exclude', exclude);
  args.push(source, target);
  return args;
}

/**
 * The default path names the mode. This used to be `<data>.golden` for what was
 * always a full backup, which is precisely how someone restores the wrong thing
 * on game night.
 */
export function snapshotPath(data, explicit, { golden = false } = {}) {
  const base = data.replace(/\/+$/, '');
  return assertOutsideRepo(explicit || `${base}${golden ? '.golden' : '.backup'}`);
}

/**
 * A pin is only installable if it names a real manifest URL. The starter
 * manifest ships "TODO" placeholders on purpose — a guessed module id fails at
 * rebuild time, which is the worst time — so those must be reported as
 * unresolved rather than fetched as if they were URLs.
 */
export function isInstallable(entry) {
  return typeof entry?.manifest === 'string' && /^https?:\/\//.test(entry.manifest);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Add a module to the core set, or update it if already there.
 *
 * The golden base is meant to be *tested and adjusted*: run a rebuild, find that
 * something is missing or broken, add it, run again. Hand-editing JSON between
 * every iteration is where mistakes creep in, so promotion is a command.
 *
 * `pin` comes from a capture or an installed module.json — never typed, because
 * module ids are routinely nothing like their titles (Chat Commander is
 * `_chatcommands`, Prime Performance is `fvtt-perf-optim`).
 */
/** Length of the common leading substring, used only for "did you mean". */
export function sharedPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n].toLowerCase() === b[n].toLowerCase()) n++;
  return n;
}

export function addToCore(manifest, pin, { note } = {}) {
  const core = [...(manifest.core ?? [])];
  const at = core.findIndex(m => m.id === pin.id);
  const entry = { ...pin, ...(note ? { note } : {}) };
  if (at === -1) {
    core.push(entry);
    return { core, action: 'added' };
  }
  // Preserve a deliberately pinned manifest URL and any existing note.
  core[at] = {
    ...core[at],
    ...entry,
    manifest: isInstallable(core[at]) ? core[at].manifest : entry.manifest || core[at].manifest,
    ...(core[at].note && !note ? { note: core[at].note } : {}),
  };
  return { core, action: 'updated' };
}

/** Drop a module from core. Reports plainly when it was not there. */
export function removeFromCore(manifest, id) {
  const core = (manifest.core ?? []).filter(m => m.id !== id);
  return { core, removed: core.length !== (manifest.core ?? []).length };
}

/**
 * Find a module's real pin without needing a capture file: read the installed
 * module.json straight from the data directory.
 */
export async function pinFromInstalled(id, data) {
  const manifestPath = path.join(data, 'Data', 'modules', id, 'module.json');
  try {
    return pinFromManifest(JSON.parse(await readFile(manifestPath, 'utf8')), id);
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') opts.data = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--golden') opts.golden = true;
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.positional.push(a);
  }
  opts.command = opts.positional.shift();
  return opts;
}

export const USAGE = `Usage:
  foundry-base.mjs capture <world> [--data <path>]   read a world's enabled modules into a pinned manifest
  foundry-base.mjs world-capture <world> [--to <p>]  record a configured world as the template for new ones
  foundry-base.mjs provision [--dry-run]             install the pinned system + modules
  foundry-base.mjs promote <capture.json>            fill core pins from a capture
  foundry-base.mjs add <id> [--from <capture>]       promote a module into core
  foundry-base.mjs remove <id>                       drop a module from core
  foundry-base.mjs update [id...]                    move pins to the latest published version
  foundry-base.mjs snapshot [--to <path>]            copy the data dir as a restore point
  foundry-base.mjs snapshot --golden [--to <path>]   copy it without worlds, as a clean slate
  foundry-base.mjs restore --yes [--from <path>]     recreate the data dir from a snapshot
  foundry-base.mjs restore --golden --yes            reset the instance, leaving worlds alone
  foundry-base.mjs pull-games                        rebuild + sync every game in the manifest
  foundry-base.mjs verify [world]                     check the install against the pins; exits 1 on failure`;

async function cmdCapture(opts) {
  const world = opts.positional[0];
  if (!world) throw new Error('capture needs a world id');
  const captured = await capture(world, opts);

  console.log(`World ${captured.world}: ${captured.modules.length} module(s) enabled`);
  if (captured.system) console.log(`  system ${captured.system.id} ${captured.system.version}`);
  for (const m of captured.modules) console.log(`  ${m.id.padEnd(28)} ${m.version}`);
  if (captured.missing.length) {
    console.log(`\nEnabled but not installed on disk (cannot pin): ${captured.missing.join(', ')}`);
  }

  let existing = null;
  try {
    existing = await loadManifest(opts.manifest);
  } catch {
    // First run: nothing to merge against.
  }
  if (existing) {
    const { notInCore, inCoreNotEnabled } = mergeCapture(existing, captured);
    if (notInCore.length) {
      console.log('\nActive in this world but NOT in core — decide before dropping:');
      for (const m of notInCore) console.log(`  ${m.id.padEnd(28)} ${m.version}  ${m.title}`);
    }
    if (inCoreNotEnabled.length) {
      console.log('\nIn core but not enabled in this world:');
      for (const m of inCoreNotEnabled) console.log(`  ${m.id}`);
    }
  }

  const out = opts.to || path.join(REPO_ROOT, `foundry-capture-${world}.json`);
  await writeFile(out, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(`\nWrote ${out}. Promote what belongs into foundry-base.json "core".`);
}

async function cmdWorldCapture(opts) {
  const world = opts.positional[0];
  if (!world) throw new Error('world-capture needs a world id');
  const template = await captureWorld(world, opts);
  const out = opts.to ? path.resolve(opts.to) : path.join(REPO_ROOT, WORLD_TEMPLATE_FILE);
  await writeFile(out, JSON.stringify(template, null, 2) + '\n');

  console.log(`Captured ${world} -> ${path.relative(REPO_ROOT, out) || out}`);
  console.log(`  core ${template.coreVersion ?? 'unknown'}, system ${template.system ?? 'none'}`);
  console.log(`  ${template.settings.length} setting(s) a new world will inherit`);
  for (const key of template.droppedAsIdentity) {
    console.log(`  dropped (identity, not preference): ${key}`);
  }
  if (template.regeneratedAtCapture.length) {
    console.log('  core.moduleConfiguration held aside — new-world regenerates it from the pins');
  }
  console.log('\nConfigure the source world the way you want EVERY new world to start,');
  console.log('then re-capture. This file is what new-world applies.');
}

/**
 * Install one pinned entry into <data>/Data/<kind>/<id>.
 *
 * The destination is created before anything is written. `provision` has to
 * work against a data directory Foundry has never started in — which is
 * exactly the state a rebuild leaves behind — and writing the zip into a
 * `Data/` that does not exist yet died with a bare ENOENT, after the download
 * had already been paid for.
 *
 * The download's status is checked too: an expired or redirected link answers
 * with an HTML error page, and unzipping that fails as "not a zipfile" rather
 * than as the fetch problem it is.
 *
 * `deps` exists so the write path can be tested without the network or a real
 * archive; nothing in production passes it.
 */
export async function installEntry(entry, data, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const unpack = deps.unpack ?? ((zip, dest) => run('unzip', ['-o', '-q', zip, '-d', dest]));

  const res = await fetchImpl(entry.manifest);
  if (!res.ok) throw new Error(`${entry.id}: manifest fetch failed (${res.status})`);
  const json = await res.json();
  if (!json.download) throw new Error(`${entry.id}: manifest has no download URL`);

  const dest = path.join(data, 'Data', entry.kind, entry.id);
  await mkdir(dest, { recursive: true });
  const zip = path.join(data, 'Data', `.${entry.id}.zip`);

  const download = await fetchImpl(json.download);
  if (!download.ok) throw new Error(`${entry.id}: download failed (${download.status})`);
  await writeFile(zip, Buffer.from(await download.arrayBuffer()));
  try {
    await unpack(zip, dest);
  } finally {
    await rm(zip, { force: true });
  }
  return dest;
}

async function cmdProvision(opts) {
  const manifest = await loadManifest(opts.manifest);
  const data = dataDir(opts.data);
  const entries = [
    ...(manifest.system ? [{ ...manifest.system, kind: 'systems' }] : []),
    ...(manifest.core ?? []).map(m => ({ ...m, kind: 'modules' })),
  ];
  if (!entries.length) throw new Error('Manifest has no system or core modules.');
  const unresolved = [];

  for (const entry of entries) {
    const dest = path.join(data, 'Data', entry.kind, entry.id);
    let installed = null;
    try {
      installed = JSON.parse(
        await readFile(
          path.join(dest, `${entry.kind === 'systems' ? 'system' : 'module'}.json`),
          'utf8',
        ),
      ).version;
    } catch {
      // not installed
    }
    if (installed === entry.version) {
      console.log(`ok       ${entry.id} ${entry.version} (already installed)`);
      continue;
    }
    if (!isInstallable(entry)) {
      unresolved.push(entry.id);
      console.log(
        `SKIP     ${entry.id}: no manifest URL pinned yet — \`capture\` a world that has it, then \`promote\``,
      );
      continue;
    }
    console.log(
      `${opts.dryRun ? 'would ' : ''}install  ${entry.id} ${entry.version}${installed ? ` (replacing ${installed})` : ''}`,
    );
    if (opts.dryRun) continue;
    await installEntry(entry, data);
  }

  if (unresolved.length) {
    console.log(
      `\n${unresolved.length} pin(s) still unresolved: ${unresolved.join(', ')}.` +
        '\nA rebuild will NOT reinstall these. Capture a world that has them enabled,' +
        '\nthen fill the pins from it:' +
        '\n  node scripts/content/foundry-base.mjs capture <world>' +
        '\n  node scripts/content/foundry-base.mjs promote foundry-capture-<world>.json',
    );
  }
}

async function cmdSnapshot(opts) {
  const golden = Boolean(opts.golden);
  const data = dataDir(opts.data);
  const target = snapshotPath(data, opts.to, { golden });
  console.log(`Snapshot${golden ? ' (golden, no worlds)' : ' (full)'} ${data} -> ${target}`);
  if (opts.dryRun) return;
  await run('rsync', rsyncArgs(`${data.replace(/\/+$/, '')}/`, `${target}/`, { golden }));
  console.log(
    golden
      ? 'Done. This is the clean slate: modules, system and config, no worlds.'
      : 'Done. This is the restore point; verify it exists before wiping anything.',
  );
}

async function cmdRestore(opts) {
  const golden = Boolean(opts.golden);
  const data = dataDir(opts.data);
  const source = snapshotPath(data, opts.from, { golden });
  await access(source).catch(() => {
    throw new Error(`No snapshot at ${source}. Nothing to restore from.`);
  });
  if (!opts.yes) {
    throw new Error(
      `Refusing to overwrite ${data} without --yes. This replaces the live data ` +
        `directory${golden ? ', leaving worlds untouched' : ', including worlds'}, with the snapshot.`,
    );
  }
  console.log(`Restore${golden ? ' (golden, worlds untouched)' : ' (full)'} ${source} -> ${data}`);
  if (opts.dryRun) return;
  await run('rsync', rsyncArgs(`${source}/`, `${data.replace(/\/+$/, '')}/`, { golden }));
}

/**
 * Move pins forward on purpose. Nothing here floats: `update` resolves the
 * latest published version, rewrites foundry-base.json, and leaves the change
 * in the working tree to be reviewed and committed like any other.
 */
async function cmdUpdate(opts) {
  const manifestPath = opts.manifest || DEFAULT_MANIFEST;
  const manifest = await loadManifest(manifestPath);
  const only = new Set(opts.positional);
  const entries = [...(manifest.system ? [manifest.system] : []), ...(manifest.core ?? [])].filter(
    e => (only.size ? only.has(e.id) : true),
  );
  if (!entries.length) throw new Error('Nothing matched — check the ids you passed.');

  const changed = [];
  for (const entry of entries) {
    if (!isInstallable(entry)) {
      console.log(`skip     ${entry.id}: no manifest URL pinned yet`);
      continue;
    }
    const res = await fetch(entry.manifest);
    if (!res.ok) {
      console.log(`FAILED   ${entry.id}: manifest fetch returned ${res.status}`);
      continue;
    }
    const latest = (await res.json()).version;
    if (!latest || latest === entry.version) {
      console.log(`current  ${entry.id} ${entry.version}`);
      continue;
    }
    console.log(`bump     ${entry.id} ${entry.version} -> ${latest}`);
    changed.push(`${entry.id} ${entry.version} -> ${latest}`);
    entry.version = latest;
  }

  if (!changed.length) {
    console.log('\nEverything already at its pinned version.');
    return;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nUpdated ${manifestPath}. Review, run \`provision\`, then commit the pin change.`);
  // The MCP bridge pin and MCP_VERSION in setup-mcp.sh are the same fact; a
  // silent divergence there is the drift this whole mechanism exists to stop.
  if (changed.some(c => c.startsWith('foundry-mcp-bridge'))) {
    console.log(
      'NOTE: foundry-mcp-bridge moved — update MCP_VERSION in scripts/setup-mcp.sh to match.',
    );
  }
}

/**
 * Fill core pins from a capture file.
 *
 * `capture` reads a world and writes what it found; this promotes those real
 * versions and manifest URLs into foundry-base.json. Kept as a separate step
 * because deciding what belongs in core is a human judgement, while copying a
 * version string is not — and hand-copying manifest URLs is exactly the kind of
 * transcription this pipeline exists to remove.
 */
async function cmdPromote(opts) {
  const capturePath = opts.positional[0];
  if (!capturePath) throw new Error('promote needs a capture file (from `capture <world>`)');
  const manifestPath = opts.manifest || DEFAULT_MANIFEST;
  const manifest = await loadManifest(manifestPath);
  const captured = JSON.parse(await readFile(capturePath, 'utf8'));

  const { core, notInCore, inCoreNotEnabled } = mergeCapture(manifest, captured);

  const filled = [];
  const stillUnresolved = [];
  for (const entry of core) {
    const before = manifest.core.find(m => m.id === entry.id);
    if (!isInstallable(before) && isInstallable(entry)) filled.push(entry.id);
    if (!isInstallable(entry)) stillUnresolved.push(entry.id);
  }

  manifest.core = core;
  if (captured.system && manifest.system?.id === captured.system.id) {
    manifest.system = {
      ...manifest.system,
      version: captured.system.version,
      manifest: isInstallable(manifest.system)
        ? manifest.system.manifest
        : captured.system.manifest,
    };
  }

  if (opts.dryRun) {
    console.log(`would fill ${filled.length} pin(s) from ${capturePath}`);
  } else {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Filled ${filled.length} pin(s) in ${manifestPath} from ${capturePath}`);
  }
  for (const id of filled) console.log(`  ${id}`);

  if (stillUnresolved.length) {
    console.log(
      `\n${stillUnresolved.length} pin(s) still have no manifest URL: ${stillUnresolved.join(', ')}.` +
        '\nThey are not in this world, or were installed without one. Capture another' +
        '\nworld that has them, or add the URL by hand.',
    );
  }
  if (inCoreNotEnabled.length) {
    console.log(
      `\nIn core but not enabled in this world: ${inCoreNotEnabled.map(m => m.id).join(', ')}`,
    );
  }
  if (notInCore.length) {
    console.log(
      `\nActive in this world but not in core (${notInCore.length}) — promote by hand if wanted:`,
    );
    for (const m of notInCore)
      console.log(`  ${m.id.padEnd(26)} ${m.version.padEnd(10)} ${m.title}`);
  }
}

/**
 * `add <id>` — promote a module into core.
 *
 * Resolution order is deliberate: a capture file if one is given, otherwise the
 * installed module.json. Both are the module telling us about itself; neither is
 * a guess.
 */
async function cmdAdd(opts) {
  const id = opts.positional[0];
  if (!id) throw new Error('add needs a module id, e.g. `add tokenmagic`');
  const manifestPath = opts.manifest || DEFAULT_MANIFEST;
  const manifest = await loadManifest(manifestPath);

  let pin = null;
  if (opts.from) {
    const captured = JSON.parse(await readFile(opts.from, 'utf8'));
    pin = (captured.modules ?? []).find(m => m.id === id) ?? null;
    if (!pin) {
      // A typo shares a prefix with the real id far more often than it contains
      // it, so `includes` alone almost never fires when it is most wanted.
      const near = (captured.modules ?? [])
        .map(m => m.id)
        .filter(m => m.includes(id) || id.includes(m) || sharedPrefix(m, id) >= 4);
      throw new Error(
        `"${id}" is not in ${opts.from}.` +
          (near.length ? `\nDid you mean: ${near.join(', ')}` : ''),
      );
    }
  } else {
    pin = await pinFromInstalled(id, dataDir(opts.data));
    if (!pin) {
      throw new Error(
        `"${id}" is not installed, so there is nothing to read a version from.\n` +
          'Pass --from <capture.json> to take it from a captured world instead.',
      );
    }
  }

  const { core, action } = addToCore(manifest, pin, { note: opts.note });
  manifest.core = core;
  if (opts.dryRun) {
    console.log(`would have ${action} ${pin.id} ${pin.version}`);
    return;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${action} ${pin.id} ${pin.version}${pin.title ? `  (${pin.title})` : ''}`);
  if (!isInstallable({ ...pin })) {
    console.log('  no manifest URL — a rebuild will not reinstall it until one is filled in');
  }
  console.log(`core is now ${core.length} module(s)`);
}

/** `remove <id>` — drop a module from core. */
async function cmdRemove(opts) {
  const id = opts.positional[0];
  if (!id) throw new Error('remove needs a module id');
  const manifestPath = opts.manifest || DEFAULT_MANIFEST;
  const manifest = await loadManifest(manifestPath);
  const { core, removed } = removeFromCore(manifest, id);
  if (!removed) {
    console.log(`"${id}" is not in core; nothing to remove.`);
    return;
  }
  manifest.core = core;
  if (opts.dryRun) {
    console.log(`would remove ${id}`);
    return;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`removed ${id}; core is now ${core.length} module(s)`);
}

/**
 * The per-game command sequence, as [cmd, args] pairs: build, then the art
 * coverage gate in strict mode, then sync. The gate sits BETWEEN build and
 * sync on purpose — an unproven module must not be able to reach Foundry.
 */
// Game entries may address the vault as "$DND_VAULT_PATH/…" so the manifest
// stays layout-independent: the env var wins (same one compose.yml uses),
// falling back to its compose default of ~/Documents/DnD. JSON cannot expand
// variables and node does not expand ~, so this is done here.
const VAULT_TOKEN = '$DND_VAULT_PATH';
function vaultRoot() {
  return process.env.DND_VAULT_PATH || path.join(os.homedir(), 'Documents', 'DnD');
}
function expandVaultPath(p) {
  if (!p || !p.startsWith(VAULT_TOKEN)) return p;
  return vaultRoot() + p.slice(VAULT_TOKEN.length);
}

// The game registry lives in the VAULT (<vault>/foundry-games.json), not in
// this repo — the repo is the pipeline, never a game's content, and a game's
// existence is content too. The repo manifest's `games` array stays empty and
// game-agnostic; anything a user does put there still works and runs first.
// Missing registry file: fine (no games). Malformed: fail loud.
export async function loadGames(manifest) {
  const games = [...(manifest.games ?? [])];
  const registry = path.join(vaultRoot(), 'foundry-games.json');
  let raw;
  try {
    raw = await readFile(registry, 'utf8');
  } catch {
    return games; // No vault registry — repo manifest entries only.
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${registry} (foundry-games.json): ${err.message}`);
  }
  const vaultGames = Array.isArray(parsed) ? parsed : parsed.games ?? [];
  return games.concat(vaultGames);
}

export function pullPlan(game) {
  const config = expandVaultPath(typeof game === 'string' ? game : game.config);
  const src = expandVaultPath(typeof game === 'string' ? undefined : game.src);
  const srcArgs = src ? ['--src', src] : [];
  return [
    ['node', [path.join(SCRIPT_DIR, 'build.mjs'), '--config', config, ...srcArgs]],
    [
      'node',
      [path.join(SCRIPT_DIR, 'art-coverage.mjs'), '--config', config, ...srcArgs, '--strict'],
    ],
    [path.join(SCRIPT_DIR, 'sync-content.sh'), ['--config', config]],
  ];
}

async function cmdPullGames(opts) {
  const manifest = await loadManifest(opts.manifest);
  const games = await loadGames(manifest);
  if (!games.length) {
    console.log(
      'No games listed — add entries to <vault>/foundry-games.json (see docs/FOUNDRY_REBUILD.md).',
    );
    return;
  }
  for (const game of games) {
    console.log(`\n=== ${typeof game === 'string' ? game : game.config}`);
    for (const [cmd, args] of pullPlan(game)) await run(cmd, args);
  }
}

// ---------------------------------------------------------------------------
// verify — turn "did the rebuild work" into a command with an exit code
// ---------------------------------------------------------------------------

/**
 * The ids a module declares it needs.
 *
 * Foundry v10 renamed `dependencies` to `relationships.requires`, and both
 * shapes are still in the wild — a module last released years before its
 * neighbours may use either. `relationships.systems` is deliberately ignored:
 * that is a compatibility statement, not something to install.
 */
export function requiredIds(json) {
  const ids = new Set();
  for (const r of json?.relationships?.requires ?? []) {
    const id = r?.id ?? r?.name;
    if (id) ids.add(id);
  }
  for (const d of json?.dependencies ?? []) {
    const id = d?.id ?? d?.name;
    // The legacy array carried systems alongside modules; only modules install.
    if (id && (d?.type ?? 'module') === 'module') ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Compare the pins against what is on disk, using EXACTLY `provision`'s
 * definition of "already installed": string equality on the version.
 *
 * Deliberately not normalised. socketlib's pin is the literal `v1.1.4`, because
 * that is what its own module.json says. A verify that quietly equated `v1.1.4`
 * with `1.1.4` would report ok on an install that `provision` then reinstalls
 * on every single run. The two commands have to agree on the word "installed",
 * or neither of them can be trusted — and a disagreement here is far more
 * likely to be a real pin problem than a cosmetic one.
 */
export function verifyPins(manifest, installed) {
  const entries = [
    ...(manifest.system ? [{ ...manifest.system, kind: 'systems' }] : []),
    ...(manifest.core ?? []).map(m => ({ ...m, kind: 'modules' })),
  ];
  return entries.map(entry => {
    const found = installed.get(entry.id);
    if (!found) {
      return { level: 'fail', id: entry.id, text: `not installed (pinned ${entry.version})` };
    }
    if (found.version !== entry.version) {
      return {
        level: 'fail',
        id: entry.id,
        text: `installed ${found.version}, pinned ${entry.version}`,
      };
    }
    return { level: 'ok', id: entry.id, text: entry.version };
  });
}

/**
 * Is the pinned set closed under its own declared requirements?
 *
 * `provision` installs exactly what is pinned and resolves no chains, so an
 * unpinned requirement is a module that comes up quietly broken after a
 * rebuild — the failure this whole manifest exists to prevent. Reading it from
 * the installed module.json files means the check needs no network, which
 * matters: three pins are hosted on gitlab.com, which the devcontainer's egress
 * allowlist does not cover.
 */
export function verifyDependencies(installedManifests, pinnedIds) {
  const pinned = new Set(pinnedIds);
  const rows = [];
  for (const [id, json] of installedManifests) {
    if (!pinned.has(id)) continue; // only the golden set has to be closed
    for (const req of requiredIds(json)) {
      if (pinned.has(req)) continue;
      rows.push({ level: 'fail', id, text: `requires ${req}, which is not pinned in core` });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.text.localeCompare(b.text));
}

/**
 * What a world actually has switched on, against the pins.
 *
 * The second half is the most useful line this command prints: a module enabled
 * here but absent from core will NOT come back after a rebuild. It is a warning
 * rather than a failure because that is routinely correct — a game's own
 * content module is enabled in its world and has no business in the golden base.
 */
export function verifyWorldModules(moduleConfiguration, pinnedIds) {
  const enabled = new Set(enabledModules(moduleConfiguration));
  const pinned = new Set(pinnedIds);
  const rows = [];
  for (const id of pinnedIds) {
    if (!enabled.has(id)) {
      rows.push({ level: 'fail', id, text: 'pinned in core but not enabled in this world' });
    }
  }
  for (const id of [...enabled].sort()) {
    if (!pinned.has(id)) {
      rows.push({
        level: 'warn',
        id,
        text: 'enabled here but not in core — a rebuild will not bring it back',
      });
    }
  }
  return rows;
}

/**
 * The world's system against the pinned one.
 *
 * A version mismatch is a warning, not a failure: `world.json` records the
 * version the world was last launched under, so it lags a fresh `provision`
 * until the world is opened once. Saying FAIL for something that fixes itself
 * on launch is how a gate gets ignored.
 */
export function verifyWorldSystem(worldJson, system) {
  if (!system) return [];
  const rows = [];
  if (worldJson?.system !== system.id) {
    rows.push({
      level: 'fail',
      id: 'system',
      text: `world runs ${worldJson?.system ?? 'nothing'}, pinned ${system.id}`,
    });
    return rows;
  }
  if (worldJson?.systemVersion !== system.version) {
    rows.push({
      level: 'warn',
      id: 'system',
      text:
        `world last launched under ${worldJson?.systemVersion ?? 'unknown'}, ` +
        `pinned ${system.version} — launch it once to migrate`,
    });
  }
  return rows;
}

/** Read an installed system.json / module.json, or null when it is not there. */
async function readInstalled(data, kind, id) {
  const file = path.join(
    data,
    'Data',
    kind,
    id,
    kind === 'systems' ? 'system.json' : 'module.json',
  );
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function printRows(title, rows) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const row of rows) {
    const tag = row.level === 'ok' ? 'ok  ' : row.level === 'warn' ? 'warn' : 'FAIL';
    console.log(`  ${tag} ${row.id.padEnd(28)} ${row.text}`);
  }
}

async function cmdVerify(opts) {
  const manifest = await loadManifest(opts.manifest);
  const data = dataDir(opts.data);
  const world = opts.positional[0];

  const installed = new Map();
  const manifests = new Map();
  const wanted = [
    ...(manifest.system ? [{ id: manifest.system.id, kind: 'systems' }] : []),
    ...(manifest.core ?? []).map(m => ({ id: m.id, kind: 'modules' })),
  ];
  for (const { id, kind } of wanted) {
    const json = await readInstalled(data, kind, id);
    if (!json) continue;
    installed.set(id, { version: json.version ?? 'unknown', kind });
    manifests.set(id, json);
  }

  const pinnedModuleIds = (manifest.core ?? []).map(m => m.id);
  const pinRows = verifyPins(manifest, installed);
  const depRows = verifyDependencies(manifests, pinnedModuleIds);

  console.log(`Verifying ${data} against ${opts.manifest || DEFAULT_MANIFEST}`);
  printRows('Pinned system and modules:', pinRows);
  printRows('Dependency closure:', depRows);
  if (!depRows.length) console.log('\nDependency closure: closed — every requirement is pinned.');

  let worldRows = [];
  if (world) {
    const worldsDir = await assertDataDir(data);
    const worldDir = path.join(worldsDir, world);
    await access(worldDir).catch(async () => {
      const available = await readdir(worldsDir).catch(() => []);
      throw new Error(
        `World "${world}" not found in ${worldsDir}.` +
          (available.length ? `\nAvailable: ${available.join(', ')}` : ''),
      );
    });
    const worldJson = JSON.parse(await readFile(path.join(worldDir, 'world.json'), 'utf8'));
    const config = await readModuleConfiguration(worldDir);
    if (!config) {
      throw new Error(
        `No core.moduleConfiguration in ${world}. Launch the world once so Foundry writes it.`,
      );
    }
    worldRows = [
      ...verifyWorldSystem(worldJson, manifest.system),
      ...verifyWorldModules(config, pinnedModuleIds),
    ];
    console.log(`\nWorld ${world} (core ${worldJson.coreVersion ?? 'unknown'}):`);
    printRows(`Modules and system:`, worldRows);
  } else {
    console.log('\nNo world given — pass one to check its enabled modules too.');
  }

  const failures = [...pinRows, ...depRows, ...worldRows].filter(r => r.level === 'fail');
  if (failures.length) {
    throw new Error(
      `${failures.length} check(s) failed. ` +
        'Run `provision` for missing or drifted pins; `add <id>` for an unpinned requirement.',
    );
  }
  console.log('\nAll checks passed.');
}

// Kept beside the switch below so a new command has to appear in both, and the
// test that compares this with USAGE fails if either is forgotten.
export const COMMANDS = [
  'capture',
  'world-capture',
  'provision',
  'promote',
  'add',
  'remove',
  'update',
  'snapshot',
  'restore',
  'pull-games',
  'verify',
];

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'capture':
      return cmdCapture(opts);
    case 'world-capture':
      return cmdWorldCapture(opts);
    case 'provision':
      return cmdProvision(opts);
    case 'promote':
      return cmdPromote(opts);
    case 'add':
      return cmdAdd(opts);
    case 'remove':
      return cmdRemove(opts);
    case 'update':
      return cmdUpdate(opts);
    case 'snapshot':
      return cmdSnapshot(opts);
    case 'restore':
      return cmdRestore(opts);
    case 'pull-games':
      return cmdPullGames(opts);
    case 'verify':
      return cmdVerify(opts);
    default:
      console.error(USAGE);
      throw new Error(opts.command ? `Unknown command: ${opts.command}` : 'No command given');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
