import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docId, validateDoc, prepareDoc, moduleManifest, COLLECTIONS } from './build.mjs';

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

test('moduleManifest shape', () => {
  const m = moduleManifest();
  assert.equal(m.id, 'troubled-waters-content');
  assert.equal(m.packs.length, 4);
  assert.ok(m.packs.every(p => p.system === 'dnd5e'));
  assert.deepEqual(m.relationships.systems[0].id, 'dnd5e');
});

test('moduleManifest declares only built packs', () => {
  const m = moduleManifest(['actors', 'journals']);
  assert.deepEqual(m.packs.map(p => p.name), ['actors', 'journals']);
});

test('COLLECTIONS maps journal collection correctly', () => {
  assert.equal(COLLECTIONS.journals.key, 'journal');
  assert.equal(COLLECTIONS.journals.type, 'JournalEntry');
});
