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
//   node scripts/content/foundry-base.mjs new-world <id> --title "<Title>"
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
import { readFile, writeFile, mkdir, access, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
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
  // `packs` lists the world's OWN compendium packs — for this table that means
  // ddb-importer's twelve world-scoped `world.ddb-*` packs, which die with the
  // world that made them. Copying the list into a new world declares packs that
  // do not exist. Same reasoning as core.compendiumConfiguration.
  'packs',
];

/**
 * Split captured settings into what a new world should inherit, what is
 * regenerated from the pins, and what is this world's identity.
 */
export function partitionSettings(rows) {
  const kept = [];
  const regenerated = [];
  const dropped = [];
  const userScoped = [];
  for (const row of rows ?? []) {
    const key = row?.key;
    if (typeof key !== 'string') continue;
    if (REGENERATED_SETTINGS.includes(key)) regenerated.push(row);
    else if (IDENTITY_SETTINGS.includes(key)) dropped.push(row);
    // A settings row with a `user` is one player's own preference, filed under
    // a user id. A new world has none of those accounts, so the row would be a
    // dead reference on arrival — identity by another route. Null and absent
    // both mean world-scoped, which is the overwhelming majority.
    else if (typeof row.user === 'string' && row.user) userScoped.push(row);
    else kept.push(row);
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  return {
    kept: kept.sort(byKey),
    regenerated: regenerated.sort(byKey),
    dropped: dropped.sort(byKey),
    userScoped: userScoped.sort(byKey),
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
/**
 * Setting keys whose value is a credential rather than a preference.
 *
 * Matched on the key, because the values are opaque by nature. ddb-importer
 * keeps a D&D Beyond session cookie in world settings, and this template is
 * meant to be read, diffed and handed around — a credential in it is a
 * credential in every copy of it, and in every terminal it is ever pasted into.
 * A new world should ask you to authenticate again; that is not a preference
 * worth inheriting.
 *
 * The pattern is a word list rather than a list of module ids, so it catches
 * modules this repo has never heard of. Three words are matched ONLY in
 * compounds, and every one of those exclusions is here because this is a VTT:
 *
 * - **`token`** — Foundry is full of tokens that are creatures on a map:
 *   `core.defaultToken`, `token-action-hud.*`, `tokenmagic.*`. Only
 *   `accessToken`, `api_token`, `authToken` match.
 * - **`auth`** — a substring of "author". Only `oauth`, `authorization` and
 *   `authToken` match.
 * - **`secret`** — a tabletop word before it is a security one. A real capture
 *   of a live world matched `dice-so-nice.hide3dDiceOnSecretRolls` and
 *   `monks-wall-enhancement.toggle-secret`: secret *rolls* and secret *doors*,
 *   both plain preferences, both silently dropped. Only `clientSecret`,
 *   `secretKey` and `api_secret` match now.
 *
 * That third one was found the hard way, and it is the argument for the whole
 * shape of this: over-matching silently drops real configuration, which is the
 * same failure a settings whitelist would have had — believing you are
 * configured when you are not. When in doubt, do not match. A credential that
 * slips through is visible in the key list; a preference that is eaten is not.
 *
 * `licence`/`license` was dropped for the same reason: nothing puts a licence
 * key in world settings, while "show licence info" toggles are plausible.
 */
export const SECRET_KEY_PATTERN =
  /(cookie|passwo?rd|credential|api[-_]?key|api[-_]?token|api[-_]?secret|access[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|oauth|authorization|private[-_]?key)/i;

/**
 * Split credential-bearing rows out of a settings set. They are dropped, not
 * blanked: writing an empty credential into a new world is indistinguishable
 * from a broken one, while an absent credential prompts for itself.
 */
export function redactSecrets(rows) {
  const kept = [];
  const redacted = [];
  for (const row of rows ?? []) {
    if (typeof row?.key === 'string' && SECRET_KEY_PATTERN.test(row.key)) redacted.push(row.key);
    else kept.push(row);
  }
  return { kept, redacted };
}

/**
 * A pack id, whole and on its own: `world.ddb-<world>-ddb-spells`,
 * `dnd5e.monsters`. Anchored deliberately — see dropWorldScopedPackRefs.
 */
const PACK_ID = /^[A-Za-z0-9._-]+$/;

/** Is this decoded value a pack id in the `world.` scope, or a list of them? */
function namesWorldScopedPack(value) {
  if (typeof value === 'string') return PACK_ID.test(value) && value.startsWith('world.');
  if (Array.isArray(value)) return value.some(namesWorldScopedPack);
  return false;
}

/**
 * Drop rows whose *value* names a pack that dies with the world it came from.
 *
 * `packs` and `core.compendiumConfiguration` are excluded by key; this is the
 * same dead reference one level down, in a value. ddb-importer stores each of
 * its twelve pack ids as a preference — `ddb-importer.entity-spell-compendium`
 * held `"world.ddb-lure-of-the-lamia-ddb-spells"` in a real capture. Cloned into
 * a new world, that names a pack only the old world has. A `world.`-scoped pack
 * lives inside the world folder; a module-scoped one (`dnd5e.monsters`) lives in
 * the module and survives, so only the `world.` scope is dropped.
 *
 * Dropped rather than rewritten: guessing a new world's pack ids means encoding
 * ddb-importer's naming scheme here, and an absent setting falls back to the
 * module's own default, which is world-correct by construction.
 *
 * The match is on the decoded value being a **whole** pack id, not a substring:
 * over-matching would eat a preference silently, which is the failure the secret
 * word list was already taught to avoid. Prose that merely mentions "world." is
 * not a pack id and is kept.
 */
export function dropWorldScopedPackRefs(rows) {
  const kept = [];
  const dropped = [];
  for (const row of rows ?? []) {
    if (typeof row?.key !== 'string') continue;
    let decoded;
    try {
      decoded = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    } catch {
      // Not JSON: nothing to read a pack id out of. Keep it.
      kept.push(row);
      continue;
    }
    if (namesWorldScopedPack(decoded)) dropped.push(row.key);
    else kept.push(row);
  }
  return { kept, dropped };
}

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
  const { kept, regenerated, dropped, userScoped } = partitionSettings(rows);
  const { kept: safe, redacted } = redactSecrets(kept);
  const { kept: portable, dropped: worldPacks } = dropWorldScopedPackRefs(safe);

  return {
    capturedFrom: world,
    // A template captured under one Foundry version is not known to apply
    // cleanly under another; new-world compares this and refuses on a mismatch
    // rather than writing a world that half-works.
    coreVersion: worldJson.coreVersion ?? null,
    system: worldJson.system ?? null,
    systemVersion: worldJson.systemVersion ?? null,
    worldShape: worldShape(worldJson),
    settings: portable,
    regeneratedAtCapture: regenerated,
    droppedAsIdentity: dropped.map(r => r.key),
    // Counted, not named: which player set what is nobody else's business, and
    // the count is what tells you whether anything was left behind.
    droppedAsUserScoped: userScoped.length,
    // Named, never valued: knowing which credentials a new world will ask for
    // is useful; carrying them is not.
    redactedAsSecret: redacted,
    // Named, because the module will rebuild these itself and you want to know
    // which modules to expect that from.
    droppedAsWorldPack: worldPacks,
  };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

/**
 * Serialise the manifest the way the repo's pre-commit hook will anyway.
 *
 * `pretty-format-json` escapes non-ASCII; plain JSON.stringify does not. With
 * the two disagreeing, every `update` rewrote each em dash in every note, so a
 * two-line pin bump arrived as a wall of encoding churn — and committing hit the
 * autofix-and-abort that makes a commit look like it worked when HEAD never
 * moved. Writing what the hook wants makes the hook a no-op.
 */
export function manifestJson(value) {
  const json = JSON.stringify(value, null, 2);
  // eslint-disable-next-line no-control-regex
  return `${json.replace(/[^\x00-\x7F]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

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

/**
 * Take an id out of `deliberatelyExcluded`, returning the reason that was
 * recorded against it.
 *
 * `add`ing a module that is on the excluded list is a contradiction: the
 * manifest would say both "pinned in core" and "kept out of core, here is why".
 * Silently leaving both in place is how a rationale file rots into fiction, and
 * refusing the add would be worse — the decision to reverse is the operator's,
 * and they have just made it. So the tool reverses it and says so, quoting the
 * reason it just overruled, in case that is news.
 */
export function dropExclusion(manifest, id) {
  const reason = manifest?.deliberatelyExcluded?.[id];
  if (reason === undefined) return null;
  delete manifest.deliberatelyExcluded[id];
  return reason;
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
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--description') opts.description = argv[++i];
    else if (a === '--system') opts.system = argv[++i];
    else if (a === '--core-version') opts.coreVersion = argv[++i];
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
  foundry-base.mjs verify [world]                     check the install against the pins; exits 1 on failure
  foundry-base.mjs new-world <id> --title "<T>"       create a world from the captured template`;

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
  if (template.droppedAsUserScoped) {
    console.log(
      `  dropped ${template.droppedAsUserScoped} row(s) belonging to a specific user — ` +
        'a new world has no such accounts',
    );
  }
  for (const key of template.droppedAsWorldPack) {
    console.log(`  dropped (names a pack of ${world}, which a new world has not): ${key}`);
  }
  if (template.droppedAsWorldPack.length) {
    console.log('  each module rebuilds its own packs in a new world.');
  }
  for (const key of template.redactedAsSecret) {
    console.log(`  redacted (credential, not preference): ${key}`);
  }
  if (template.redactedAsSecret.length) {
    console.log('  those are not in the file — sign in again in the new world.');
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
/** The file that makes a directory a module or a system to Foundry. */
function manifestFileFor(kind) {
  return kind === 'systems' ? 'system.json' : 'module.json';
}

/**
 * Read the version actually installed at <data>/Data/<kind>/<id>.
 *
 * The pin is a record, not a constraint: most manifest URLs in foundry-base.json
 * resolve to `/latest/` or a branch tip, so `provision` installs whatever is
 * current and has to report what it really put down. Absent or malformed both
 * yield null — "nothing usable here" is an answer, not an error.
 */
export async function installedVersion(data, entry) {
  const file = path.join(data, 'Data', entry.kind, entry.id, manifestFileFor(entry.kind));
  try {
    return JSON.parse(await readFile(file, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Move a wrapped payload up so the manifest sits at the module root.
 *
 * Found by the first end-to-end rebuild drill: seven of twenty-five pins ship a
 * release zip with a single top-level folder, so unzipping into
 * `Data/modules/<id>/` produced `Data/modules/<id>/<id>-<version>/module.json`.
 * Foundry cannot see that, `verify` reported "not installed", and `provision`
 * reported success — nothing had failed, the files were simply one level too
 * deep. Silence was the whole defect.
 *
 * Only an unambiguous wrap is unwound: exactly one directory, and the manifest
 * inside it. Anything else throws and names the module, because guessing at a
 * layout is how a module ends up half-installed.
 */
async function flattenIfWrapped(dest, entry) {
  const manifest = manifestFileFor(entry.kind);
  const entries = await readdir(dest, { withFileTypes: true });
  if (entries.some(e => e.isFile() && e.name === manifest)) return;

  const dirs = entries.filter(e => e.isDirectory());
  const wrapper = dirs.length === 1 ? path.join(dest, dirs[0].name) : null;
  if (wrapper) {
    const inner = await readdir(wrapper);
    if (inner.includes(manifest)) {
      for (const name of inner) {
        await rename(path.join(wrapper, name), path.join(dest, name));
      }
      await rm(wrapper, { recursive: true, force: true });
      return;
    }
  }
  throw new Error(
    `${entry.id}: no ${manifest} in the unpacked payload (found: ` +
      `${entries.map(e => e.name).join(', ') || 'nothing'}). ` +
      'The download succeeded, so this is a layout this installer does not know.',
  );
}

export async function installEntry(entry, data, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const unpack = deps.unpack ?? ((zip, dest) => run('unzip', ['-o', '-q', zip, '-d', dest]));

  const res = await fetchImpl(entry.manifest);
  if (!res.ok) throw new Error(`${entry.id}: manifest fetch failed (${res.status})`);
  const json = await res.json();
  // A pinned `download` wins over the manifest's own. A version-locked manifest
  // is not a version-locked module: foundry-mcp-bridge's v0.8.2 manifest points
  // its download at /releases/latest/, so provision read 0.8.2 and installed
  // 0.8.3 — the pin looked honest and the disk disagreed.
  const downloadUrl = entry.download || json.download;
  if (!downloadUrl) throw new Error(`${entry.id}: manifest has no download URL`);

  const dest = path.join(data, 'Data', entry.kind, entry.id);
  await mkdir(dest, { recursive: true });
  const zip = path.join(data, 'Data', `.${entry.id}.zip`);

  const download = await fetchImpl(downloadUrl);
  if (!download.ok) throw new Error(`${entry.id}: download failed (${download.status})`);
  await writeFile(zip, Buffer.from(await download.arrayBuffer()));
  try {
    await unpack(zip, dest);
  } finally {
    await rm(zip, { force: true });
  }
  await flattenIfWrapped(dest, entry);
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
  const drifted = [];

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

    // Say what actually landed. Most pinned manifest URLs resolve to /latest/
    // or a branch tip, so the line above echoes the pin while the disk gets
    // whatever is current — the first rebuild drill installed eight modules
    // newer than their pins and reported success for all of them.
    const got = await installedVersion(data, entry);
    if (got !== entry.version) {
      drifted.push({ id: entry.id, want: entry.version, got });
      console.log(
        `  DRIFT  ${entry.id}: pinned ${entry.version}, the URL served ${got ?? 'nothing'}`,
      );
    }
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

  if (drifted.length) {
    throw new Error(
      `${drifted.length} pin(s) did not install at their pinned version:\n` +
        drifted.map(d => `  ${d.id}: wanted ${d.want}, got ${d.got ?? 'nothing'}`).join('\n') +
        '\n\nThe pin is not what fetched this — the manifest URL is, and most of' +
        '\nthem resolve to /latest/ or a branch tip, so they serve whatever is' +
        '\ncurrent. A rebuild that installs versions nobody chose is the hazard' +
        '\nthis manifest exists to prevent, so this exits non-zero.' +
        '\n\nTwo ways forward, and they are a real choice:' +
        '\n  update <id>   move the pin to what is current, deliberately, in a commit' +
        '\n  version-lock  edit the manifest URL to name a version, as scene-packer' +
        '\n                does — the only pin in core that cannot drift',
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
  await writeFile(manifestPath, manifestJson(manifest));
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
    await writeFile(manifestPath, manifestJson(manifest));
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
  const overruled = dropExclusion(manifest, pin.id);
  if (opts.dryRun) {
    console.log(`would have ${action} ${pin.id} ${pin.version}`);
    if (overruled !== null) {
      console.log(`  would drop it from deliberatelyExcluded, which said: ${overruled}`);
    }
    return;
  }
  await writeFile(manifestPath, manifestJson(manifest));
  console.log(`${action} ${pin.id} ${pin.version}${pin.title ? `  (${pin.title})` : ''}`);
  if (overruled !== null) {
    console.log(`  removed from deliberatelyExcluded, which said: ${overruled}`);
    console.log('  that reason is now gone from the manifest — put it in --note if it still holds');
  }
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
  await writeFile(manifestPath, manifestJson(manifest));
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
export function verifyWorldModules(moduleConfiguration, pinnedIds, excluded = {}) {
  const enabled = new Set(enabledModules(moduleConfiguration));
  const pinned = new Set(pinnedIds);
  const rows = [];
  for (const id of pinnedIds) {
    if (!enabled.has(id)) {
      rows.push({ level: 'fail', id, text: 'pinned in core but not enabled in this world' });
    }
  }
  for (const id of [...enabled].sort()) {
    if (pinned.has(id)) continue;
    // A module in deliberatelyExcluded is not an oversight — someone wrote down
    // why it is out. Repeating the generic warning at them every run is how a
    // report teaches people to skim it.
    const reason = excluded[id];
    rows.push({
      level: 'warn',
      id,
      text: reason
        ? `enabled here, deliberately excluded from core: ${reason}`
        : 'enabled here but not in core — a rebuild will not bring it back',
    });
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
      ...verifyWorldModules(config, pinnedModuleIds, manifest.deliberatelyExcluded ?? {}),
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
        'Run `provision` for a missing pin; `add <id>` for an unpinned requirement. ' +
        'A pin installed at the WRONG version will not be fixed by provision — its ' +
        'manifest URL floats, so `update <id>` the pin or version-lock the URL.',
    );
  }
  console.log('\nAll checks passed.');
}

// ---------------------------------------------------------------------------
// new-world — apply the captured template so a new world starts configured
// ---------------------------------------------------------------------------

/**
 * Foundry world ids become directory names and appear inside every `@UUID` that
 * points at the world's own documents, so they are effectively permanent. This
 * refuses anything that would be awkward as either.
 */
export function assertValidWorldId(id) {
  if (!id) throw new Error('new-world needs a world id, e.g. `new-world winters-teeth`');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `"${id}" is not usable as a world id.\n` +
        'Use lowercase letters, digits and hyphens, starting with a letter or digit.\n' +
        'The id becomes a directory name and is baked into every @UUID pointing at\n' +
        "this world's documents — renaming it later breaks them all.",
    );
  }
  return id;
}

/**
 * The LevelDB key a settings row lives under.
 *
 * Foundry prefixes it: `!settings!<document id>`. Confirmed by reading a live
 * world rather than assumed — a bare id writes rows the server never looks at,
 * which fails as an empty settings screen rather than as an error.
 */
export function settingsDbKey(id) {
  return `!settings!${id}`;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A Foundry document id: 16 characters of base62.
 *
 * Each character is drawn with `randomInt(62)`, which rejection-samples, rather
 * than by taking a random byte modulo 62. Modulo would bias the result: 256 is
 * not a multiple of 62, so the first eight letters of the alphabet would come up
 * five times in every 256 draws and the rest four. Small, and it costs nothing
 * to not have.
 *
 * `random` is injectable so a test can pin that the value is used unmodified.
 */
export function documentId(random = randomInt) {
  let out = '';
  for (let i = 0; i < 16; i++) out += ID_ALPHABET[random(ID_ALPHABET.length)];
  return out;
}

/**
 * The world manifest for a new world: the captured shape, with identity put
 * back.
 *
 * The shape is copied rather than composed. Foundry's world.json gains and
 * loses fields between versions and this repo has already paid once for
 * guessing at Foundry's vocabulary, so every field the source world had — known
 * to this tool or not — travels unread.
 */
export function newWorldJson(template, { id, title, description, system, coreVersion } = {}) {
  assertValidWorldId(id);
  if (!title) throw new Error('new-world needs --title "<Title>" — it is what Foundry displays');
  if (!template?.worldShape) {
    throw new Error(
      `Template has no worldShape. Recapture it:\n` +
        '  node scripts/content/foundry-base.mjs world-capture <a configured world>',
    );
  }
  const world = { ...template.worldShape, id, title };
  if (description !== undefined) world.description = description;
  if (system) world.system = system;
  if (coreVersion) world.coreVersion = coreVersion;
  return world;
}

/**
 * The module set a new world switches on: the pins, not the source world's
 * history.
 *
 * `world-capture` holds `core.moduleConfiguration` aside rather than carrying
 * it, because a world's enabled set drifts — it accumulates whatever was being
 * tried that month. The manifest is the deliberate list, so it wins.
 */
export function moduleConfigurationFor(manifest) {
  const config = {};
  for (const entry of manifest?.core ?? []) config[entry.id] = true;
  return config;
}

/**
 * Every settings row the new world starts with: the inherited preferences, plus
 * a regenerated module configuration.
 *
 * Each row keeps whatever fields it was captured with. Where a row carries its
 * own `_id`, it is reissued: two worlds sharing a document id is a collision
 * waiting for the first tool that assumes ids are unique.
 */
export function settingsToWrite(template, manifest, { newId = documentId } = {}) {
  const rows = [];
  for (const row of template?.settings ?? []) rows.push(freshRow(row, newId));
  const config = moduleConfigurationFor(manifest);
  if (Object.keys(config).length) {
    // Take the captured row's shape so any field Foundry expects travels, then
    // overwrite the part that must not: the enabled set comes from the pins.
    const shape = template?.regeneratedAtCapture?.[0] ?? {};
    rows.push(
      freshRow({ ...shape, key: 'core.moduleConfiguration', value: JSON.stringify(config) }, newId),
    );
  }
  return rows;
}

/**
 * One settings row, re-identified for a world that has never existed.
 *
 * Two fields point at the world it came from and are reissued or cleared:
 * `_id`, because two worlds sharing a document id is a collision waiting for
 * the first tool that assumes ids are unique; and `_stats.lastModifiedBy`,
 * which names a user account the new world does not have.
 *
 * Everything else travels untouched, including fields this tool has never heard
 * of — the same rule the capture side follows.
 */
export function freshRow(row, newId = documentId) {
  const copy = { ...row, _id: newId() };
  if (copy._stats && typeof copy._stats === 'object') {
    copy._stats = { ...copy._stats, lastModifiedBy: null };
  }
  return copy;
}

async function loadWorldTemplate(explicit) {
  const file = explicit ? path.resolve(explicit) : path.join(REPO_ROOT, WORLD_TEMPLATE_FILE);
  try {
    return { template: JSON.parse(await readFile(file, 'utf8')), file };
  } catch {
    throw new Error(
      `No world template at ${file}.\n` +
        'Configure one world the way you want every new world to start, then:\n' +
        '  node scripts/content/foundry-base.mjs world-capture <that world>',
    );
  }
}

async function cmdNewWorld(opts) {
  const id = assertValidWorldId(opts.positional[0]);
  const manifest = await loadManifest(opts.manifest);
  const { template, file } = await loadWorldTemplate(opts.from);
  const data = dataDir(opts.data);
  const worldsDir = await assertDataDir(data);
  const worldDir = path.join(worldsDir, id);

  // Never overwrite a world. A world is somebody's campaign.
  const exists = await access(worldDir).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`${worldDir} already exists. Refusing to touch an existing world.`);

  const worldJson = newWorldJson(template, {
    id,
    title: opts.title,
    description: opts.description,
    system: opts.system,
    coreVersion: opts.coreVersion,
  });
  const rows = settingsToWrite(template, manifest);
  const keyed = rows.map(row => [settingsDbKey(row._id), row]);

  console.log(`${opts.dryRun ? 'would create' : 'creating'} ${worldDir}`);
  console.log(
    `  from ${path.relative(REPO_ROOT, file) || file}, captured from ${template.capturedFrom ?? 'unknown'}`,
  );
  console.log(`  system ${worldJson.system ?? 'none'}, core ${worldJson.coreVersion ?? 'unknown'}`);
  console.log(
    `  ${rows.length} settings row(s), of which 1 is a regenerated core.moduleConfiguration`,
  );
  console.log(
    `  ${Object.keys(moduleConfigurationFor(manifest)).length} module(s) enabled from the pins`,
  );

  // The template records the Foundry version it was taken under. This tool
  // cannot read the installed version — the Foundry application lives outside
  // the data directory in the container image — so it reports rather than
  // refuses. Upgrading Foundry and then applying an older template is the case
  // to watch for.
  console.log(
    `\nTemplate was captured under core ${template.coreVersion ?? 'unknown'}. If Foundry has` +
      '\nmoved since, re-capture first, or pass --core-version to write a different one.',
  );

  if (opts.dryRun) {
    console.log('\nwould write world.json:');
    console.log(JSON.stringify(worldJson, null, 2));
    console.log('\nwould write settings (document id -> setting key):');
    for (const [dbKey, row] of keyed) console.log(`  ${dbKey}  ${row.key}`);
    return;
  }

  await mkdir(path.join(worldDir, 'data'), { recursive: true });
  await writeFile(path.join(worldDir, 'world.json'), `${JSON.stringify(worldJson, null, 2)}\n`);

  const { ClassicLevel } = await import('classic-level');
  const db = new ClassicLevel(path.join(worldDir, 'data', 'settings'), { valueEncoding: 'json' });
  try {
    await db.open();
    await db.batch(keyed.map(([dbKey, row]) => ({ type: 'put', key: dbKey, value: row })));
  } catch (err) {
    throw new Error(explainLevelError(err, `the settings for ${id}`));
  } finally {
    await db.close().catch(() => {});
  }

  console.log(`\nWrote ${worldDir}. Start Foundry and it should appear configured.`);
  console.log(`Check it without opening a settings screen:`);
  console.log(`  node scripts/content/foundry-base.mjs verify ${id}`);
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
  'new-world',
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
    case 'new-world':
      return cmdNewWorld(opts);
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
