#!/usr/bin/env node
/**
 * Print the deterministic compendium id and full @UUID cross-link for a
 * content source file.
 * Usage: node scripts/content/uuid.mjs --config <path> <type>/<file>.json ["Display Name"]
 *   e.g. node scripts/content/uuid.mjs --config examples/demo-game/ashwake-hollow.config.json \
 *          actors/rook-vantle.json "Rook Vantle"
 *
 * The document id is derived from the path alone, but the module id in the
 * @UUID comes from the config, so --config is REQUIRED: there is no default
 * module to fall back on, and a link naming the wrong module resolves to
 * nothing in the VTT.
 */
import { docId, COLLECTIONS, loadConfig } from './build.mjs';

const argv = process.argv.slice(2);
let configPath;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--config') {
    configPath = argv[i + 1];
    if (!configPath) {
      console.error('--config requires a path');
      process.exit(1);
    }
    i += 1;
  } else {
    positional.push(argv[i]);
  }
}

const [relPath, displayName] = positional;
if (!relPath || !configPath) {
  console.error(
    'Usage: node scripts/content/uuid.mjs --config <path> <type>/<file>.json ["Display Name"]',
  );
  if (!configPath)
    console.error(
      '--config is required: the @UUID names a module, and this repo has no default one.',
    );
  process.exit(1);
}

const type = relPath.split('/')[0];
const collection = COLLECTIONS[type];
if (!collection || !relPath.endsWith('.json')) {
  console.error(
    `Path must look like <type>/<file>.json with type one of: ${Object.keys(COLLECTIONS).join(', ')}`,
  );
  process.exit(1);
}

const name =
  displayName ??
  relPath
    .slice(type.length + 1, -'.json'.length)
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const id = docId(relPath);
const { id: moduleId } = await loadConfig(configPath);
console.log(id);
console.log(`@UUID[Compendium.${moduleId}.${type}.${collection.type}.${id}]{${name}}`);
