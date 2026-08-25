#!/usr/bin/env node
/**
 * Build a game's compendium module from its source tree.
 *
 * Both halves are always named by the caller: `--config <game config>` supplies
 * the module identity (id, title, system, ...) and `--src <dir>` (or the config's
 * `srcDir`, for the in-repo layout) supplies the documents. This repo is the
 * pipeline, not a game — there is deliberately no default module and no default
 * source tree to fall back on.
 * Usage: node scripts/content/build.mjs
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import { tokenSquares } from './statblock.mjs';

// Scaffolded by the foundry-gm Claude Code plugin; bump on breaking tooling
// changes so the skill can detect stale consumer copies.
export const TOOLING_VERSION = 1;

// `plural` is the human label shown in Foundry's compendium sidebar — naive
// `${type}s` would read "JournalEntrys" / "RollTables".
export const COLLECTIONS = {
  actors: { key: 'actors', type: 'Actor', plural: 'Actors' },
  items: { key: 'items', type: 'Item', plural: 'Items' },
  journals: { key: 'journal', type: 'JournalEntry', plural: 'Journals' },
  macros: { key: 'macros', type: 'Macro', plural: 'Macros' },
  scenes: { key: 'scenes', type: 'Scene', plural: 'Scenes' },
  tables: { key: 'tables', type: 'RollTable', plural: 'Roll Tables' },
};

const REQUIRED_FIELDS = {
  actors: ['name', 'type'],
  items: ['name', 'type'],
  journals: ['name', 'pages'],
  // A macro with no command is a button that does nothing — the one failure
  // mode you would not notice until you pressed it mid-session.
  macros: ['name', 'type', 'command'],
  scenes: ['name'],
  tables: ['name', 'results'],
};

export function docId(relPath) {
  return createHash('sha256').update(relPath).digest('hex').slice(0, 16);
}

export function validateDoc(doc, type, file) {
  const errors = [];
  for (const field of REQUIRED_FIELDS[type]) {
    if (doc[field] === undefined || doc[field] === null) {
      errors.push(`${file}: missing required field "${field}"`);
    }
  }
  return errors;
}

// Embedded collections per pack collection, mirroring the CLI's HIERARCHY map.
// assignKeys recurses only ARRAY-valued embeds; the CLI's object-valued
// sub-embeds (scenes' tokens.delta, regions.behaviors) are NOT handled here —
// scene conversion (dd2vtt-to-scene.mjs) emits only walls/lights/notes arrays,
// so their keys are assigned correctly.
const EMBEDDED = {
  actors: ['items', 'effects'],
  items: ['effects'],
  journal: ['pages', 'categories'],
  tables: ['results'],
  scenes: [
    'walls',
    'lights',
    'tokens',
    'notes',
    'sounds',
    'tiles',
    'drawings',
    'templates',
    'regions',
  ],
};

function assignKeys(doc, collection, sublevelPrefix, idPrefix, seed) {
  const sublevel = sublevelPrefix ? `${sublevelPrefix}.${collection}` : collection;
  doc._id ??= docId(seed);
  const id = idPrefix ? `${idPrefix}.${doc._id}` : doc._id;
  doc._key = `!${sublevel}!${id}`;
  for (const name of EMBEDDED[collection] ?? []) {
    if (!Array.isArray(doc[name])) continue;
    doc[name].forEach((child, i) => assignKeys(child, name, sublevel, id, `${seed}#${name}[${i}]`));
  }
}

// Size an actor's token from its dnd5e size trait, unless the source says
// otherwise. Foundry would normally do this in Actor5e._preCreate, but that
// hook does not run for a packed document — so a Large NPC authored without an
// explicit width/height packs as a 1x1 token and covers one 5 ft square on the
// map instead of four. An author who writes width/height by hand outranks us.
export function sizeToken(doc) {
  const size = doc.system?.traits?.size;
  if (!size) return doc;
  const token = (doc.prototypeToken ??= {});
  if (token.width === undefined) token.width = tokenSquares(size);
  if (token.height === undefined) token.height = tokenSquares(size);
  return doc;
}

/**
 * Folder documents for a compendium, from the folder names its docs declare.
 *
 * A pack arrives in Foundry as one flat list, which is fine for six NPCs and
 * unusable once a game also ships a party. A doc says which folder it wants by
 * NAME — `"folder": "Pregens"` — and this turns those names into the folder
 * documents Foundry needs, rewriting each doc to point at the id.
 *
 * `extra` names folders to create with nothing in them. That is not a quirk: a
 * game ships a PCs folder so the table has somewhere to put the characters
 * players bring, and it is empty by definition.
 *
 * Ids are derived from the pack and the folder name, so a rebuild puts
 * everything back where it was rather than orphaning what a GM had filed.
 */
export function buildFolders(docs, collection, { extra = [] } = {}) {
  const declared = docs.map(doc => doc.folder).filter(name => typeof name === 'string' && name);
  const names = [...new Set([...declared, ...extra])].sort();
  if (!names.length) return { folders: [], byName: new Map() };

  const type = COLLECTIONS[collection].type;
  const byName = new Map();
  const folders = names.map((name, index) => {
    const id = docId(`${collection}/folder/${name}`);
    byName.set(name, id);
    return {
      _id: id,
      _key: `!folders!${id}`,
      name,
      type,
      sorting: 'a',
      sort: (index + 1) * 100000,
      folder: null,
      description: '',
      flags: {},
    };
  });

  for (const doc of docs) {
    if (typeof doc.folder === 'string' && byName.has(doc.folder))
      doc.folder = byName.get(doc.folder);
    else if (doc.folder !== undefined) delete doc.folder;
  }
  return { folders, byName };
}

export function prepareDoc(doc, type, relPath) {
  const out = structuredClone(doc);
  if (type === 'actors') sizeToken(out);
  assignKeys(out, COLLECTIONS[type].key, '', '', relPath);
  return out;
}

// Cross-links to this module must resolve to a source file staged in this
// build; a broken @UUID is exactly the bug that otherwise survives to the
// game table.
export function validateLinks(doc, relPath, moduleId, idType) {
  const errors = [];
  const pattern = new RegExp(
    `@UUID\\[Compendium\\.${moduleId}\\.([a-z]+)\\.([A-Za-z]+)\\.([a-f0-9]{16})\\]`,
    'g',
  );
  for (const [, pack, , id16] of JSON.stringify(doc).matchAll(pattern)) {
    if (!(id16 in idType)) {
      errors.push(`${relPath}: broken @UUID link — no source file has id ${id16} (pack "${pack}")`);
    } else if (idType[id16] !== pack) {
      errors.push(
        `${relPath}: @UUID link points at pack "${pack}" but id ${id16} lives in "${idType[id16]}"`,
      );
    }
  }
  return errors;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
// No DEFAULT_CONFIG_PATH. A repo-level default module made one game's content
// the implicit subject of every command; every entry point now names its game.
const NO_CONFIG =
  'A module config path is required — pass --config <game config> ' +
  '(e.g. "<vault>/03 Oneshots/<Game>/Foundry/<slug>.config.json").';

export async function loadConfig(configPath) {
  if (!configPath) throw new Error(NO_CONFIG);
  let raw;
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read module config ${configPath}: ${err.message}`);
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    throw new Error(`${configPath}: "id" must be lowercase kebab-case`);
  }
  if (typeof raw.title !== 'string' || !raw.title) {
    throw new Error(`${configPath}: "title" is required`);
  }
  return {
    description: 'Campaign content authored as code.',
    version: '1.0.0',
    compatibility: { minimum: '12', verified: '14' },
    ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
    ...raw,
  };
}

// srcRoot precedence: explicit arg > config "srcDir" (a dir under content/).
// There is no third tier: a build that names neither has nothing to compile,
// and saying so beats silently compiling whatever happens to sit in content/src.
export function resolveSrcRoot(config, srcRoot) {
  if (srcRoot) return srcRoot;
  if (config?.srcDir) return path.join(REPO_ROOT, 'content', config.srcDir);
  throw new Error(
    'No source tree — pass --src <dir> (vault-hosted games) or set "srcDir" ' +
      'in the module config (the in-repo layout).',
  );
}

export async function main({
  srcRoot,
  distRoot = path.join(REPO_ROOT, 'content', 'dist'),
  configPath,
} = {}) {
  if (!configPath) throw new Error(NO_CONFIG);
  const config = await loadConfig(configPath);
  const resolvedSrcRoot = resolveSrcRoot(config, srcRoot);
  const moduleDir = path.join(distRoot, config.id);
  await rm(moduleDir, { recursive: true, force: true });

  const errors = [];
  const staged = {}; // type -> staging dir
  const counts = {};
  const idType = {}; // id16 -> source pack (dir) name, for link validation
  const prepared = []; // [type, file, doc]

  for (const type of Object.keys(COLLECTIONS)) {
    const typeDir = path.join(resolvedSrcRoot, type);
    counts[type] = 0;
    if (!existsSync(typeDir)) continue;
    const files = (await readdir(typeDir)).filter(f => f.endsWith('.json'));
    if (files.length === 0) continue;

    for (const file of files) {
      const relPath = `${type}/${file}`;
      let doc;
      try {
        doc = JSON.parse(await readFile(path.join(typeDir, file), 'utf8'));
      } catch (err) {
        errors.push(`${relPath}: malformed JSON (${err.message})`);
        continue;
      }
      const docErrors = validateDoc(doc, type, relPath);
      if (docErrors.length) {
        errors.push(...docErrors);
        continue;
      }
      const out = prepareDoc(doc, type, relPath);
      idType[out._id] = type;
      prepared.push([type, file, out]);
    }
  }

  for (const [type, file, doc] of prepared) {
    errors.push(...validateLinks(doc, `${type}/${file}`, config.id, idType));
  }

  // Folders, before staging: buildFolders rewrites each doc's folder NAME to
  // the folder's id, so it has to run while the docs are still in hand.
  const folderDocs = {};
  if (!errors.length) {
    for (const type of Object.keys(COLLECTIONS)) {
      const ofType = prepared.filter(([t]) => t === type).map(([, , doc]) => doc);
      const extra = config.folders?.[type] ?? [];
      if (!ofType.length && !extra.length) continue;
      folderDocs[type] = buildFolders(ofType, type, { extra }).folders;
    }
  }

  if (!errors.length) {
    for (const [type, file, doc] of prepared) {
      if (!staged[type]) {
        const stageDir = path.join(distRoot, '.stage', type);
        await mkdir(stageDir, { recursive: true });
        staged[type] = stageDir;
      }
      await writeFile(path.join(staged[type], file), JSON.stringify(doc, null, 2));
      counts[type] += 1;
    }
  }

  // Folder documents are staged alongside the docs they hold. A folder with
  // nothing in it still needs staging — a game ships an empty PCs folder so the
  // table has somewhere to put the characters players bring.
  for (const [type, folders] of Object.entries(folderDocs)) {
    if (!folders.length) continue;
    if (!staged[type]) {
      const stageDir = path.join(distRoot, '.stage', type);
      await mkdir(stageDir, { recursive: true });
      staged[type] = stageDir;
    }
    for (const folder of folders) {
      await writeFile(
        path.join(staged[type], `_folder-${folder._id}.json`),
        JSON.stringify(folder, null, 2),
      );
    }
  }

  if (errors.length) {
    await rm(path.join(distRoot, '.stage'), { recursive: true, force: true });
    throw new Error(`Build failed:\n${errors.join('\n')}`);
  }

  for (const [type, stageDir] of Object.entries(staged)) {
    const packDir = path.join(moduleDir, 'packs', type);
    await mkdir(packDir, { recursive: true });
    await compilePack(stageDir, packDir, { log: false });
  }
  await rm(path.join(distRoot, '.stage'), { recursive: true, force: true });

  await mkdir(moduleDir, { recursive: true });
  const manifest = moduleManifest(Object.keys(staged), config);
  await writeFile(path.join(moduleDir, 'module.json'), JSON.stringify(manifest, null, 2));
  return { counts, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let configPath;
  let srcRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      const p = argv[++i];
      if (!p) {
        console.error('--config requires a path');
        process.exit(1);
      }
      configPath = path.resolve(p);
    } else if (argv[i] === '--src') {
      // Source trees do not have to live in this repo. A game whose notes are
      // Obsidian-synced can keep its module sources beside them and build from
      // there; the repo stays the pipeline, not the content.
      const p = argv[++i];
      if (!p) {
        console.error('--src requires a path');
        process.exit(1);
      }
      srcRoot = path.resolve(p);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (!configPath) {
    console.error(NO_CONFIG);
    console.error('usage: node scripts/content/build.mjs --config <path> [--src <dir>]');
    process.exit(1);
  }
  main({ configPath, srcRoot })
    .then(({ counts, config }) => {
      console.log(`Built ${config.id}:`, counts);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

// Foundry fails to register packs whose directory is missing, so the manifest
// must list only the packs the build actually compiled. Packs carry a system
// only when the config declares one; omitted means system-agnostic.
export function moduleManifest(builtTypes, config) {
  const labelPrefix = config.packLabelPrefix ?? config.title;
  const packs = builtTypes
    .map(src => [src, COLLECTIONS[src]])
    .map(([src, c]) => ({
      name: src,
      label: `${labelPrefix} ${c.plural}`,
      path: `packs/${src}`,
      type: c.type,
      ...(config.system ? { system: config.system } : {}),
      ownership: config.ownership,
    }));
  return {
    id: config.id,
    title: config.title,
    description: config.description,
    version: config.version,
    compatibility: config.compatibility,
    packs,
    ...(config.system
      ? { relationships: { systems: [{ id: config.system, type: 'system', compatibility: {} }] } }
      : {}),
  };
}
