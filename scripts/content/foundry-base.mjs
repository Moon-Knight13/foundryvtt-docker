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
//   node scripts/content/foundry-base.mjs provision [--dry-run]
//   node scripts/content/foundry-base.mjs update [id...]
//   node scripts/content/foundry-base.mjs snapshot [--to <path>]
//   node scripts/content/foundry-base.mjs restore --yes [--from <path>]
//   node scripts/content/foundry-base.mjs pull-games
//
// Why pinned: "always latest" is the documented hazard, not the goal — see
// docs/PROJECT.md on foundry-mcp module/server version drift. `update` is how
// you move, deliberately and in a reviewable commit.
//
// SECURITY: the data directory contains license.json and the admin key. This
// script never reads, parses or prints either. `snapshot` copies the directory
// wholesale with cp -a, which necessarily includes them — so the snapshot path
// must live outside the repo tree and is refused if it does not.
import path from 'node:path';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'foundry-base.json');

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
    return fresh
      ? {
          ...pin,
          version: fresh.version,
          manifest: pin.manifest || fresh.manifest,
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

export function snapshotPath(data, explicit) {
  return assertOutsideRepo(explicit || `${data.replace(/\/+$/, '')}.golden`);
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

export function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') opts.data = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.positional.push(a);
  }
  opts.command = opts.positional.shift();
  return opts;
}

const USAGE = `Usage:
  foundry-base.mjs capture <world> [--data <path>]   read a world's enabled modules into a pinned manifest
  foundry-base.mjs provision [--dry-run]             install the pinned system + modules
  foundry-base.mjs update [id...]                    move pins to the latest published version
  foundry-base.mjs snapshot [--to <path>]            copy the data dir as a restore point
  foundry-base.mjs restore --yes [--from <path>]     recreate the data dir from a snapshot
  foundry-base.mjs pull-games                        rebuild + sync every game in the manifest`;

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
        `SKIP     ${entry.id}: no manifest URL pinned yet — run \`capture <world>\` to fill it in`,
      );
      continue;
    }
    console.log(
      `${opts.dryRun ? 'would ' : ''}install  ${entry.id} ${entry.version}${installed ? ` (replacing ${installed})` : ''}`,
    );
    if (opts.dryRun) continue;

    const res = await fetch(entry.manifest);
    if (!res.ok) throw new Error(`${entry.id}: manifest fetch failed (${res.status})`);
    const json = await res.json();
    if (!json.download) throw new Error(`${entry.id}: manifest has no download URL`);
    const zip = path.join(data, 'Data', `.${entry.id}.zip`);
    const buf = Buffer.from(await (await fetch(json.download)).arrayBuffer());
    await writeFile(zip, buf);
    await mkdir(dest, { recursive: true });
    await run('unzip', ['-o', '-q', zip, '-d', dest]);
    await run('rm', ['-f', zip]);
  }

  if (unresolved.length) {
    console.log(
      `\n${unresolved.length} pin(s) still unresolved: ${unresolved.join(', ')}.` +
        '\nA rebuild will NOT reinstall these. Run `capture <world>` against a world' +
        '\nthat has them enabled, then promote the real ids into foundry-base.json.',
    );
  }
}

async function cmdSnapshot(opts) {
  const data = dataDir(opts.data);
  const target = snapshotPath(data, opts.to);
  console.log(`Snapshot ${data} -> ${target}`);
  if (opts.dryRun) return;
  await run('rsync', ['-a', '--delete', `${data.replace(/\/+$/, '')}/`, `${target}/`]);
  console.log('Done. This is the restore point; verify it exists before wiping anything.');
}

async function cmdRestore(opts) {
  const data = dataDir(opts.data);
  const source = snapshotPath(data, opts.from);
  await access(source).catch(() => {
    throw new Error(`No snapshot at ${source}. Nothing to restore from.`);
  });
  if (!opts.yes) {
    throw new Error(
      `Refusing to overwrite ${data} without --yes. This replaces the live data ` +
        'directory, including worlds, with the snapshot.',
    );
  }
  console.log(`Restore ${source} -> ${data}`);
  if (opts.dryRun) return;
  await run('rsync', ['-a', '--delete', `${source}/`, `${data.replace(/\/+$/, '')}/`]);
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

async function cmdPullGames(opts) {
  const manifest = await loadManifest(opts.manifest);
  const games = manifest.games ?? [];
  if (!games.length) {
    console.log('No games listed in the manifest — nothing to pull.');
    return;
  }
  for (const game of games) {
    const config = typeof game === 'string' ? game : game.config;
    const src = typeof game === 'string' ? undefined : game.src;
    console.log(`\n=== ${config}`);
    const buildArgs = [path.join(SCRIPT_DIR, 'build.mjs'), '--config', config];
    if (src) buildArgs.push('--src', src);
    await run('node', buildArgs);
    await run(path.join(SCRIPT_DIR, 'sync-content.sh'), ['--config', config]);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'capture':
      return cmdCapture(opts);
    case 'provision':
      return cmdProvision(opts);
    case 'update':
      return cmdUpdate(opts);
    case 'snapshot':
      return cmdSnapshot(opts);
    case 'restore':
      return cmdRestore(opts);
    case 'pull-games':
      return cmdPullGames(opts);
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
