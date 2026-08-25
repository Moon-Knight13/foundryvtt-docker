import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import { fieldMap } from './sheet-fields.mjs';
import {
  NOTE_BOXES,
  annotate,
  annotateSheet,
  noteText,
  parseArgs,
  pickBox,
  synthesizeAcroForm,
} from './sheet-annotate.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const VAULT =
  process.env.DND_VAULT_PATH ||
  [path.resolve(SCRIPT_DIR, '..', '..', 'DnD'), path.join(os.homedir(), 'DnD')].find(p =>
    existsSync(p),
  ) ||
  null;
const POOL = VAULT && path.join(VAULT, '01 Systems', 'dnd5e', 'Pregens');
const SHEET = POOL && path.join(POOL, 'human_fighter', 'human_fighter_lv1.pdf');
const skip = SHEET && existsSync(SHEET) ? false : 'vault not mounted';

// --------------------------------------------------------------------------
// Pure helpers — no PDF needed.
// --------------------------------------------------------------------------

test('noteText is empty when a game declares no hooks', () => {
  assert.equal(noteText([]), '');
  assert.equal(noteText(), '');
});

test('noteText names the game and lists each hook', () => {
  const text = noteText(['the Captain places your name.', 'the Sage nods you through.'], {
    game: 'Lure of the Lamia',
  });
  assert.match(text, /^Lure of the Lamia — your part in it$/m);
  assert.match(text, /^\* the Captain places your name\.$/m);
  assert.match(text, /^\* the Sage nods you through\.$/m);
});

test('Backstory is claimed before the fallbacks', () => {
  assert.equal(NOTE_BOXES[0], 'Backstory');
});

test('parseArgs needs exactly one sheet and an output', () => {
  assert.deepEqual(parseArgs(['a.pdf', '--out', 'b.pdf']).sheets, ['a.pdf']);
  assert.throws(() => parseArgs(['--out', 'b.pdf']), /usage/);
  assert.throws(() => parseArgs(['a.pdf', 'b.pdf', '--out', 'c.pdf']), /usage/);
  assert.throws(() => parseArgs(['a.pdf', '--out', 'b.pdf', '--wat']), /Unknown argument/);
});

test('parseArgs collects repeated --text', () => {
  const opts = parseArgs(['a.pdf', '--out', 'b.pdf', '--text', 'one', '--text', 'two']);
  assert.deepEqual(opts.text, ['one', 'two']);
});

// --------------------------------------------------------------------------
// Against a real pool sheet. This is the test that matters: a D&D Beyond
// export carries no AcroForm, so everything here depends on synthesizing one,
// and the whole point of annotating rather than reprinting is that the other
// 774 fields come through untouched.
// --------------------------------------------------------------------------

test('a D&D Beyond export carries no AcroForm, and we add one', { skip }, async () => {
  const bytes = await readFile(SHEET);
  const pdf = await PDFDocument.load(bytes);

  assert.equal(pdf.catalog.lookup(PDFName.of('AcroForm')), undefined);
  // getForm() CREATES an empty AcroForm as a side effect, so this both proves
  // pdf-lib is blind and leaves behind the empty form the next line must cope
  // with.
  assert.equal(pdf.getForm().getFields().length, 0, 'pdf-lib is blind without an AcroForm');

  const registered = synthesizeAcroForm(pdf);
  assert.equal(registered, 775);
  assert.equal(pdf.getForm().getFields().length, 775);
});

test('synthesizing twice is a no-op', { skip }, async () => {
  const pdf = await PDFDocument.load(await readFile(SHEET));
  assert.equal(synthesizeAcroForm(pdf), 775);
  assert.equal(synthesizeAcroForm(pdf), 0, 'an existing AcroForm is left alone');
});

test('writing one box changes exactly one value', { skip }, async () => {
  const source = await readFile(SHEET);
  const before = fieldMap(source);

  const after = fieldMap(await annotate(source, { Backstory: 'HOOK: the Captain knows you.' }));

  assert.equal(Object.keys(after).length, Object.keys(before).length);
  const changed = Object.keys(before).filter(name => before[name] !== after[name]);
  assert.deepEqual(changed, ['Backstory']);
  assert.equal(after.Backstory, 'HOOK: the Captain knows you.');
});

test('the annotation renders at the size the publisher set', { skip }, async () => {
  const bytes = await annotate(await readFile(SHEET), { Backstory: 'rendered?' });
  const pdf = await PDFDocument.load(bytes);
  synthesizeAcroForm(pdf);
  const field = pdf.getForm().getTextField('Backstory');

  // An appearance stream is what makes text visible on paper. Without one the
  // value is in the file and absent from the page.
  const ap = field.acroField.dict.lookup(PDFName.of('AP'));
  assert.ok(ap, 'no appearance stream — the hook would be invisible');

  const da = String(field.acroField.dict.lookup(PDFName.of('DA')));
  assert.match(da, /\/Helvetica 7 Tf/, 'the export sets an explicit 7pt, never auto-size');
});

test('a name that is not on the sheet is refused, not silently dropped', { skip }, async () => {
  const source = await readFile(SHEET);
  await assert.rejects(() => annotate(source, { NotABox: 'x' }), /no field named "NotABox"/);
});

test(
  'annotate hands back a Buffer, because a Uint8Array reads as zero fields',
  { skip },
  async () => {
    const out = await annotate(await readFile(SHEET), { Backstory: 'x' });
    assert.ok(Buffer.isBuffer(out));
    assert.equal(Object.keys(fieldMap(out)).length, 775);
  },
);

test('pickBox takes Backstory when it is free', { skip }, async () => {
  const pdf = await PDFDocument.load(await readFile(SHEET));
  synthesizeAcroForm(pdf);
  assert.equal(pickBox(pdf.getForm()).name, 'Backstory');
});

test('pickBox never overwrites a box the source sheet filled', { skip }, async () => {
  const filled = await annotate(await readFile(SHEET), { Backstory: 'authored by hand' });
  const pdf = await PDFDocument.load(filled);
  synthesizeAcroForm(pdf);

  assert.equal(pickBox(pdf.getForm()).name, 'AdditionalNotes1');
});

test('pickBox refuses rather than choosing a box it would damage', { skip }, async () => {
  const full = await annotate(
    await readFile(SHEET),
    Object.fromEntries(NOTE_BOXES.map(b => [b, 'taken'])),
  );
  const pdf = await PDFDocument.load(full);
  synthesizeAcroForm(pdf);

  assert.throws(() => pickBox(pdf.getForm()), /No free text box/);
});

test('annotateSheet returns the source untouched when there are no hooks', { skip }, async () => {
  const source = await readFile(SHEET);
  const { bytes, box, text } = await annotateSheet(source, []);

  assert.equal(box, null);
  assert.equal(text, '');
  assert.equal(bytes, source, 'no hooks means no rewrite at all');
});

test('annotateSheet writes the hooks it was given', { skip }, async () => {
  const { bytes, box } = await annotateSheet(
    await readFile(SHEET),
    ['the Guard Captain places your name.'],
    { game: 'Lure of the Lamia' },
  );

  assert.equal(box, 'Backstory');
  const written = fieldMap(bytes).Backstory;
  assert.match(written, /Lure of the Lamia/);
  assert.match(written, /Guard Captain/);
});

test('the pool sheet on disk is never modified', { skip }, async () => {
  const before = await readFile(SHEET);
  await annotateSheet(before, ['a hook'], { game: 'Somewhere' });
  const after = await readFile(SHEET);

  assert.deepEqual(after, before, 'the pool is root truth and read-only');
});
