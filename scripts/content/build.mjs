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

export function prepareDoc(doc, type, relPath) {
  const out = structuredClone(doc);
  out._id = docId(relPath);
  out._key = `!${COLLECTIONS[type].key}!${out._id}`;
  const embedded = type === 'journals' ? out.pages : type === 'actors' ? out.items : null;
  if (Array.isArray(embedded)) {
    embedded.forEach((child, i) => {
      child._id ??= docId(`${relPath}#${i}`);
    });
  }
  return out;
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
