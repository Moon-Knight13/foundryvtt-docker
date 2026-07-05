#!/usr/bin/env node
/**
 * Build the content compendium module from content/src.
 * Module identity (id, title, system, ...) comes from content/content.config.json.
 * Usage: node scripts/content/build.mjs
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '@foundryvtt/foundryvtt-cli';

// Scaffolded by the foundry-gm Claude Code plugin; bump on breaking tooling
// changes so the skill can detect stale consumer copies.
export const TOOLING_VERSION = 1;

export const COLLECTIONS = {
  actors:   { key: 'actors',  type: 'Actor' },
  items:    { key: 'items',   type: 'Item' },
  journals: { key: 'journal', type: 'JournalEntry' },
  scenes:   { key: 'scenes',  type: 'Scene' },
  tables:   { key: 'tables',  type: 'RollTable' },
};

const REQUIRED_FIELDS = {
  actors:   ['name', 'type'],
  items:    ['name', 'type'],
  journals: ['name', 'pages'],
  scenes:   ['name'],
  tables:   ['name', 'results'],
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
const EMBEDDED = {
  actors: ['items', 'effects'],
  items: ['effects'],
  journal: ['pages', 'categories'],
  tables: ['results'],
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

export function prepareDoc(doc, type, relPath) {
  const out = structuredClone(doc);
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
    'g'
  );
  for (const [, pack, , id16] of JSON.stringify(doc).matchAll(pattern)) {
    if (!(id16 in idType)) {
      errors.push(`${relPath}: broken @UUID link — no source file has id ${id16} (pack "${pack}")`);
    } else if (idType[id16] !== pack) {
      errors.push(`${relPath}: @UUID link points at pack "${pack}" but id ${id16} lives in "${idType[id16]}"`);
    }
  }
  return errors;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'content', 'content.config.json');

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
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
    compatibility: { minimum: '12', verified: '13' },
    ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
    ...raw,
  };
}

export async function main({
  srcRoot = path.join(REPO_ROOT, 'content', 'src'),
  distRoot = path.join(REPO_ROOT, 'content', 'dist'),
  configPath = DEFAULT_CONFIG_PATH,
} = {}) {
  const config = await loadConfig(configPath);
  const moduleDir = path.join(distRoot, config.id);
  await rm(moduleDir, { recursive: true, force: true });

  const errors = [];
  const staged = {}; // type -> staging dir
  const counts = {};
  const idType = {}; // id16 -> source pack (dir) name, for link validation
  const prepared = []; // [type, file, doc]

  for (const type of Object.keys(COLLECTIONS)) {
    const typeDir = path.join(srcRoot, type);
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
  main()
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
  const packs = builtTypes.map(src => [src, COLLECTIONS[src]]).map(([src, c]) => ({
    name: src,
    label: `${labelPrefix} ${c.type}s`,
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
