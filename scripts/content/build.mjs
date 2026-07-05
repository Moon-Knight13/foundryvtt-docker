#!/usr/bin/env node
/**
 * Build the troubled-waters-content compendium module from content/src.
 * Usage: node scripts/content/build.mjs
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePack } from '@foundryvtt/foundryvtt-cli';

export const MODULE_ID = 'troubled-waters-content';

export const COLLECTIONS = {
  actors:   { key: 'actors',  type: 'Actor' },
  items:    { key: 'items',   type: 'Item' },
  journals: { key: 'journal', type: 'JournalEntry' },
  scenes:   { key: 'scenes',  type: 'Scene' },
};

const REQUIRED_FIELDS = {
  actors:   ['name', 'type'],
  items:    ['name', 'type'],
  journals: ['name', 'pages'],
  scenes:   ['name'],
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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export async function main({
  srcRoot = path.join(REPO_ROOT, 'content', 'src'),
  distRoot = path.join(REPO_ROOT, 'content', 'dist'),
} = {}) {
  const moduleDir = path.join(distRoot, MODULE_ID);
  await rm(moduleDir, { recursive: true, force: true });

  const errors = [];
  const staged = {}; // type -> staging dir
  const counts = {};

  for (const type of Object.keys(COLLECTIONS)) {
    const typeDir = path.join(srcRoot, type);
    counts[type] = 0;
    if (!existsSync(typeDir)) continue;
    const files = (await readdir(typeDir)).filter(f => f.endsWith('.json'));
    if (files.length === 0) continue;

    const stageDir = path.join(distRoot, '.stage', type);
    await mkdir(stageDir, { recursive: true });
    staged[type] = stageDir;

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
      const prepared = prepareDoc(doc, type, relPath);
      await writeFile(path.join(stageDir, file), JSON.stringify(prepared, null, 2));
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
  await writeFile(path.join(moduleDir, 'module.json'), JSON.stringify(moduleManifest(), null, 2));
  return { counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(({ counts }) => {
      console.log(`Built ${MODULE_ID}:`, counts);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}

export function moduleManifest() {
  const packs = Object.entries(COLLECTIONS).map(([src, c]) => ({
    name: src,
    label: `Troubled Waters ${c.type}s`,
    path: `packs/${src}`,
    type: c.type,
    system: 'dnd5e',
    ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
  }));
  return {
    id: MODULE_ID,
    title: 'Troubled Waters Content',
    description: 'Campaign content authored as code in the project repository.',
    version: '1.0.0',
    compatibility: { minimum: '12', verified: '13' },
    packs,
    relationships: { systems: [{ id: 'dnd5e', type: 'system', compatibility: {} }] },
  };
}
