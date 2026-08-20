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
//   node scripts/content/foundry-base.mjs promote <capture.json>
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
import os from 'node:os';
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainLevelError } from './leveldb.mjs';

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
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.positional.push(a);
  }
  opts.command = opts.positional.shift();
  return opts;
}

export const USAGE = `Usage:
  foundry-base.mjs capture <world> [--data <path>]   read a world's enabled modules into a pinned manifest
  foundry-base.mjs provision [--dry-run]             install the pinned system + modules
  foundry-base.mjs promote <capture.json>            fill core pins from a capture
  foundry-base.mjs add <id> [--from <capture>]       promote a module into core
  foundry-base.mjs remove <id>                       drop a module from core
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
        `SKIP     ${entry.id}: no manifest URL pinned yet — \`capture\` a world that has it, then \`promote\``,
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
        '\nA rebuild will NOT reinstall these. Capture a world that has them enabled,' +
        '\nthen fill the pins from it:' +
        '\n  node scripts/content/foundry-base.mjs capture <world>' +
        '\n  node scripts/content/foundry-base.mjs promote foundry-capture-<world>.json',
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

// Kept beside the switch below so a new command has to appear in both, and the
// test that compares this with USAGE fails if either is forgotten.
export const COMMANDS = [
  'capture',
  'provision',
  'promote',
  'add',
  'remove',
  'update',
  'snapshot',
  'restore',
  'pull-games',
];

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'capture':
      return cmdCapture(opts);
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
