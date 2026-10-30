#!/usr/bin/env node
/**
 * Print the deterministic compendium id and full @UUID cross-link for a
 * content source file.
 * Usage: node scripts/content/uuid.mjs <type>/<file>.json ["Display Name"]
 *   e.g. node scripts/content/uuid.mjs actors/grimtooth-the-fence.json "Grimtooth"
 */
import { docId, COLLECTIONS, loadConfig } from './build.mjs';

const [relPath, displayName] = process.argv.slice(2);
if (!relPath) {
  console.error('Usage: node scripts/content/uuid.mjs <type>/<file>.json ["Display Name"]');
  process.exit(1);
}

const type = relPath.split('/')[0];
const collection = COLLECTIONS[type];
if (!collection || !relPath.endsWith('.json')) {
  console.error(
    `Path must look like <type>/<file>.json with type one of: ${Object.keys(COLLECTIONS).join(', ')}`
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
const { id: moduleId } = await loadConfig();
console.log(id);
console.log(`@UUID[Compendium.${moduleId}.${type}.${collection.type}.${id}]{${name}}`);
