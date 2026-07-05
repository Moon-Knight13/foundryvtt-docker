import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  docId, validateDoc, prepareDoc, moduleManifest, validateLinks, loadConfig, COLLECTIONS,
} from './build.mjs';

const CONFIG = {
  id: 'test-content',
  title: 'Test Content',
  description: 'Test.',
  version: '1.0.0',
  system: 'dnd5e',
  packLabelPrefix: 'Test',
  compatibility: { minimum: '12', verified: '13' },
  ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
};

test('docId is deterministic, 16 chars, alnum', () => {
  const a = docId('actors/grimtooth.json');
  assert.equal(a, docId('actors/grimtooth.json'));
  assert.match(a, /^[a-z0-9]{16}$/);
  assert.notEqual(a, docId('actors/other.json'));
});

test('validateDoc flags missing required fields', () => {
  assert.deepEqual(validateDoc({ name: 'X', type: 'npc' }, 'actors', 'f.json'), []);
  assert.ok(validateDoc({ type: 'npc' }, 'actors', 'f.json').some(e => e.includes('name')));
  assert.ok(validateDoc({ name: 'X' }, 'actors', 'f.json').some(e => e.includes('type')));
  assert.ok(validateDoc({ name: 'Q' }, 'journals', 'f.json').some(e => e.includes('pages')));
  assert.deepEqual(validateDoc({ name: 'Q', pages: [] }, 'journals', 'f.json'), []);
  assert.deepEqual(validateDoc({ name: 'S' }, 'scenes', 'f.json'), []);
  assert.ok(validateDoc({ name: 'T' }, 'tables', 'f.json').some(e => e.includes('results')));
  assert.deepEqual(validateDoc({ name: 'T', results: [] }, 'tables', 'f.json'), []);
});

test('prepareDoc injects _id and _key', () => {
  const out = prepareDoc({ name: 'X', type: 'npc' }, 'actors', 'actors/x.json');
  assert.match(out._id, /^[a-z0-9]{16}$/);
  assert.equal(out._key, `!actors!${out._id}`);
});

test('prepareDoc gives journal pages stable embedded ids', () => {
  const doc = { name: 'Q', pages: [{ name: 'P1', type: 'text' }] };
  const out = prepareDoc(doc, 'journals', 'journals/q.json');
  assert.equal(out._key, `!journal!${out._id}`);
  assert.match(out.pages[0]._id, /^[a-z0-9]{16}$/);
  assert.equal(out.pages[0]._key, `!journal.pages!${out._id}.${out.pages[0]._id}`);
  const again = prepareDoc(doc, 'journals', 'journals/q.json');
  assert.equal(out.pages[0]._id, again.pages[0]._id);
});

test('prepareDoc gives roll table results embedded keys', () => {
  const doc = { name: 'T', results: [{ type: 'text', description: 'A rat', range: [1, 1] }] };
  const out = prepareDoc(doc, 'tables', 'tables/t.json');
  assert.equal(out._key, `!tables!${out._id}`);
  assert.equal(out.results[0]._key, `!tables.results!${out._id}.${out.results[0]._id}`);
});

test('moduleManifest shape follows config', () => {
  const m = moduleManifest(Object.keys(COLLECTIONS), CONFIG);
  assert.equal(m.id, 'test-content');
  assert.equal(m.title, 'Test Content');
  assert.equal(m.packs.length, 5);
  assert.ok(m.packs.every(p => p.system === 'dnd5e'));
  assert.ok(m.packs.every(p => p.label.startsWith('Test ')));
  assert.deepEqual(m.relationships.systems[0].id, 'dnd5e');
});

test('moduleManifest omits system when config has none', () => {
  const { system, ...agnostic } = CONFIG;
  const m = moduleManifest(['journals'], agnostic);
  assert.ok(!('system' in m.packs[0]));
  assert.ok(!('relationships' in m));
});

test('moduleManifest declares only built packs', () => {
  const m = moduleManifest(['actors', 'journals'], CONFIG);
  assert.deepEqual(m.packs.map(p => p.name), ['actors', 'journals']);
});

test('COLLECTIONS maps journal and table collections correctly', () => {
  assert.equal(COLLECTIONS.journals.key, 'journal');
  assert.equal(COLLECTIONS.journals.type, 'JournalEntry');
  assert.equal(COLLECTIONS.tables.key, 'tables');
  assert.equal(COLLECTIONS.tables.type, 'RollTable');
});

test('loadConfig applies defaults and validates id/title', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fvtt-config-'));
  const file = path.join(dir, 'content.config.json');

  await writeFile(file, JSON.stringify({ id: 'my-content', title: 'My Content' }));
  const config = await loadConfig(file);
  assert.equal(config.id, 'my-content');
  assert.equal(config.version, '1.0.0');
  assert.deepEqual(config.ownership, { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' });
  assert.equal(config.system, undefined);

  await writeFile(file, JSON.stringify({ id: 'Bad Id', title: 'X' }));
  await assert.rejects(() => loadConfig(file), /kebab-case/);
  await writeFile(file, JSON.stringify({ id: 'ok-id' }));
  await assert.rejects(() => loadConfig(file), /"title" is required/);
  await assert.rejects(() => loadConfig(path.join(dir, 'missing.json')), /Cannot read module config/);
});

test('validateLinks resolves ids and pack placement', () => {
  const targetId = docId('actors/vela.json');
  const idType = { [targetId]: 'actors' };
  const link = who =>
    ({ name: 'J', pages: [{ type: 'text', text: { content: `see @UUID[Compendium.test-content.actors.Actor.${who}]{Vela}` } }] });

  assert.deepEqual(validateLinks(link(targetId), 'journals/j.json', 'test-content', idType), []);

  const missing = 'a'.repeat(16);
  const errs = validateLinks(link(missing), 'journals/j.json', 'test-content', idType);
  assert.ok(errs.some(e => e.includes('broken @UUID link')));

  const wrongPack = { name: 'J', pages: [{ type: 'text', text: { content: `@UUID[Compendium.test-content.items.Item.${targetId}]{Vela}` } }] };
  const packErrs = validateLinks(wrongPack, 'journals/j.json', 'test-content', idType);
  assert.ok(packErrs.some(e => e.includes('lives in "actors"')));

  // Links to other modules/compendia are not ours to validate.
  const foreign = { name: 'J', pages: [{ type: 'text', text: { content: `@UUID[Compendium.dnd5e.monsters.Actor.${missing}]{Rat}` } }] };
  assert.deepEqual(validateLinks(foreign, 'journals/j.json', 'test-content', idType), []);
});
