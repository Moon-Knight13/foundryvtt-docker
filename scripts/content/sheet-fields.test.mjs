import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { fieldMap, fingerprint, readFields } from './sheet-fields.mjs';

// The real sheets live in the vault, which is gitignored and absent in CI, so
// every test here builds the PDF it needs. That is not a compromise: a
// hand-built file can hold exactly the one awkward shape under test, which a
// 700KB sheet cannot.

/** Assemble numbered objects into a file this parser will accept. */
function pdf(objects, { trailer = '<< /Root 1 0 R >>' } = {}) {
  const parts = [Buffer.from('%PDF-1.7\n')];
  for (const [num, body] of objects) {
    parts.push(Buffer.from(`${num} 0 obj\n`));
    parts.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    parts.push(Buffer.from('\nendobj\n'));
  }
  parts.push(Buffer.from(`trailer\n${trailer}\nstartxref\n0\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A catalog whose AcroForm lists the given field object numbers. */
function catalog(fieldNums) {
  return [
    [1, '<< /Type /Catalog /AcroForm 2 0 R >>'],
    [2, `<< /Fields [ ${fieldNums.map(n => `${n} 0 R`).join(' ')} ] >>`],
  ];
}

test('reads a text field name, value and type', () => {
  const buf = pdf([...catalog([10]), [10, '<< /FT /Tx /T (CharacterName) /V (Elf Wizard) >>']]);
  assert.deepEqual(readFields(buf), [{ name: 'CharacterName', type: 'text', value: 'Elf Wizard' }]);
});

test('a value containing brackets survives', () => {
  // The vault's Elf_Wizard.pdf really does carry "(Milestone)" in its XP box.
  // A `/V \(([^)]*)\)` regex reads that as "(Milestone" and silently loses the
  // close bracket, which is why this parses escapes properly instead.
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /FT /Tx /T (EXPERIENCE POINTS) /V (\\(Milestone\\)) >>'],
  ]);
  assert.equal(fieldMap(buf)['EXPERIENCE POINTS'], '(Milestone)');
});

test('field names keep whitespace exactly as authored', () => {
  // `DEXmod ` and `Wpn3 AtkBonus  ` are the real names on real sheets. Trimming
  // them here would produce a generator that writes to boxes that do not exist.
  const buf = pdf([
    ...catalog([10, 11, 12]),
    [10, '<< /FT /Tx /T (DEXmod ) /V (+2) >>'],
    [11, '<< /FT /Tx /T (Wpn3 AtkBonus  ) >>'],
    [12, '<< /FT /Tx /T (SpellSaveDC  2) >>'],
  ]);
  const names = readFields(buf).map(f => f.name);
  assert.deepEqual(names, ['DEXmod ', 'Wpn3 AtkBonus  ', 'SpellSaveDC  2']);
});

test('a checkbox reports its state as a name, not as text', () => {
  // /V /Off is a state; "Off" as a string would read as a filled-in box.
  const buf = pdf([
    ...catalog([10, 11]),
    [10, '<< /FT /Btn /T (Check Box 12) /V /Off >>'],
    [11, '<< /FT /Btn /T (Check Box 13) /V /Yes >>'],
  ]);
  const fields = readFields(buf);
  assert.deepEqual(fields[0], { name: 'Check Box 12', type: 'button', value: 'Off' });
  assert.deepEqual(fields[1], { name: 'Check Box 13', type: 'button', value: 'Yes' });
});

test('a hex-encoded name and value decode', () => {
  const buf = pdf([...catalog([10]), [10, '<< /FT /Tx /T <4143> /V <2B32> >>']]);
  assert.deepEqual(readFields(buf), [{ name: 'AC', type: 'text', value: '+2' }]);
});

test('a UTF-16 value decodes rather than arriving as mojibake', () => {
  const utf16 = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Sage', 'utf16le').swap16()]);
  const buf = pdf([
    ...catalog([10]),
    [
      10,
      Buffer.concat([
        Buffer.from('<< /FT /Tx /T (BACKGROUND) /V <'),
        Buffer.from(utf16.toString('hex')),
        Buffer.from('> >>'),
      ]),
    ],
  ]);
  assert.equal(fieldMap(buf).BACKGROUND, 'Sage');
});

test('type and value are inherited from the parent field', () => {
  // Radio groups and multi-widget fields put /FT and /V on the parent only.
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /FT /Tx /T (HPMax) /V (8) /Kids [ 11 0 R 12 0 R ] >>'],
    [11, '<< /Type /Annot /Subtype /Widget /Parent 10 0 R >>'],
    [12, '<< /Type /Annot /Subtype /Widget /Parent 10 0 R >>'],
  ]);
  assert.deepEqual(readFields(buf), [{ name: 'HPMax', type: 'text', value: '8' }]);
});

test('one name shared by widgets on three pages is one field', () => {
  // AcroForm semantics, and the reason the writer sets `Wpn Name` once and it
  // appears on every page that shows it.
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /FT /Tx /T (Wpn Name) /V (Quarterstaff) /Kids [ 11 0 R 12 0 R 13 0 R ] >>'],
    [11, '<< /Subtype /Widget /Parent 10 0 R >>'],
    [12, '<< /Subtype /Widget /Parent 10 0 R >>'],
    [13, '<< /Subtype /Widget /Parent 10 0 R >>'],
  ]);
  assert.equal(readFields(buf).length, 1);
  assert.equal(fieldMap(buf)['Wpn Name'], 'Quarterstaff');
});

test('a nested field is reported by its qualified name', () => {
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /T (Attack) /Kids [ 11 0 R ] >>'],
    [11, '<< /FT /Tx /T (Damage) /V (1d6) /Parent 10 0 R >>'],
  ]);
  const names = readFields(buf).map(f => f.name);
  assert.ok(names.includes('Attack.Damage'), `expected a qualified name, got ${names.join(', ')}`);
});

test('fields hidden in a compressed object stream are found', () => {
  // This is the one that matters on real files. Scanning the raw bytes of a
  // modern sheet finds no /AcroForm at all, because the catalog and every field
  // live inside an ObjStm — which makes a fillable form look flattened.
  const inner = [
    '<< /Type /Catalog /AcroForm 2 0 R >>',
    '<< /Fields [ 10 0 R ] >>',
    '<< /FT /Tx /T (ProfBonus) /V (+2) >>',
  ];
  const nums = [1, 2, 10];
  const offsets = [];
  let body = '';
  for (const obj of inner) {
    offsets.push(body.length);
    body += `${obj} `;
  }
  const header = nums.map((n, i) => `${n} ${offsets[i]}`).join(' ') + ' ';
  const payload = deflateSync(Buffer.from(header + body, 'latin1'));
  const stream = Buffer.concat([
    Buffer.from(
      `<< /Type /ObjStm /N ${nums.length} /First ${header.length} /Filter /FlateDecode /Length ${payload.length} >>\nstream\n`,
    ),
    payload,
    Buffer.from('\nendstream'),
  ]);
  const buf = pdf([[20, stream]]);
  assert.deepEqual(readFields(buf), [{ name: 'ProfBonus', type: 'text', value: '+2' }]);
});

test('a field the form no longer lists is not reported', () => {
  // The supplied WotC blank carries two orphans — `CharacterPortrait` and
  // `FactionName 1` — marked with a `removed` key, absent from /Fields and from
  // every page. A regex over the bytes counts 336 fields; the form has 334.
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /FT /Tx /T (Alignment) >>'],
    [11, '<< /FT /Tx /T (FactionName 1) /removed true >>'],
  ]);
  assert.deepEqual(
    readFields(buf).map(f => f.name),
    ['Alignment'],
  );
});

test('a sheet with no usable AcroForm still reads', () => {
  // A damaged catalog should cost accuracy, not the whole file.
  const buf = pdf([[10, '<< /FT /Tx /T (CharacterName) /V (Dwarf Cleric) >>']], {
    trailer: '<< >>',
  });
  assert.equal(fieldMap(buf).CharacterName, 'Dwarf Cleric');
});

test('an empty field reads as empty, and an absent value as null', () => {
  // The difference matters for the identity check: a sheet handed to a stranger
  // must have no player name, and "" and null both satisfy that while "Off"
  // and a real string do not.
  const buf = pdf([
    ...catalog([10, 11]),
    [10, '<< /FT /Tx /T (PlayerName) /V () >>'],
    [11, '<< /FT /Tx /T (Age) >>'],
  ]);
  const fields = readFields(buf);
  assert.equal(fields[0].value, '');
  assert.equal(fields[1].value, null);
});

test('fingerprint pins the bytes and counts only genuinely filled boxes', () => {
  const buf = pdf([
    ...catalog([10, 11, 12]),
    [10, '<< /FT /Tx /T (CharacterName) /V (Elf Wizard) >>'],
    [11, '<< /FT /Btn /T (Check Box 12) /V /Off >>'],
    [12, '<< /FT /Tx /T (Age) >>'],
  ]);
  const print = fingerprint(buf);
  assert.equal(print.fieldCount, 3);
  assert.equal(print.filledCount, 1, 'an unticked box and an empty box are not filled');
  assert.match(print.sha256, /^[0-9a-f]{64}$/);
  assert.equal(print.bytes, buf.length);
  assert.deepEqual(print.names, ['Age', 'CharacterName', 'Check Box 12']);
});

test('fingerprint is stable across identical bytes and moves with a change', () => {
  // The registry pins a blank template by this checksum, so that a publisher
  // reissuing the sheet with renamed boxes fails the build instead of quietly
  // producing sheets with empty spaces where the renamed fields were.
  const one = pdf([...catalog([10]), [10, '<< /FT /Tx /T (AC) /V (15) >>']]);
  const same = pdf([...catalog([10]), [10, '<< /FT /Tx /T (AC) /V (15) >>']]);
  const other = pdf([...catalog([10]), [10, '<< /FT /Tx /T (AC) /V (16) >>']]);
  assert.equal(fingerprint(one).sha256, fingerprint(same).sha256);
  assert.notEqual(fingerprint(one).sha256, fingerprint(other).sha256);
});

test('a cycle in the field tree terminates', () => {
  const buf = pdf([
    ...catalog([10]),
    [10, '<< /T (Loop) /Kids [ 11 0 R ] >>'],
    [11, '<< /FT /Tx /T (Inner) /Parent 10 0 R /Kids [ 10 0 R ] >>'],
  ]);
  const names = readFields(buf).map(f => f.name);
  assert.ok(names.includes('Loop.Inner'));
});

// --------------------------------------------------------------------------
// The oracle
//
// Everything above proves the parser handles a shape. These prove it handles
// the actual files, which is the only claim worth making: the two forms in the
// vault are the ones a pregen has to be written onto and checked against.
//
// The vault is gitignored and absent in CI, so these skip there. They are not
// optional on a host that has it — the numbers below were measured, and a
// change in them is a change in the file, not in the test.
// --------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VAULT =
  process.env.DND_VAULT_PATH ||
  [path.resolve(SCRIPT_DIR, '..', '..', 'DnD'), path.join(os.homedir(), 'DnD')].find(p =>
    existsSync(p),
  ) ||
  null;

const BLANK =
  VAULT && path.join(VAULT, '01 Systems', 'dnd5e', 'Pregens', 'templates', 'wotc-2014.pdf');
const WIZARD =
  VAULT &&
  path.join(VAULT, '02 Campaigns', 'Dragons of Stormwreck Isle', 'Pregens', 'Elf_Wizard.pdf');
const vaultSheet = file => (file && existsSync(file) ? readFileSync(file) : null);

test(
  'the WotC blank reads as an empty 334-field form',
  { skip: !vaultSheet(BLANK) && 'vault not mounted' },
  () => {
    const print = fingerprint(vaultSheet(BLANK));
    assert.equal(print.fieldCount, 334);
    assert.equal(print.filledCount, 0, 'a template with anything already in it is not a template');
    const names = new Set(print.names);
    for (const expected of [
      'CharacterName',
      'ProfBonus',
      'Alignment',
      'Background',
      'Acrobatics',
      'Backstory',
    ]) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }
    // Three attack rows is the print ceiling this sheet imposes; the generator
    // has to fail on a fourth rather than drop a weapon silently.
    assert.deepEqual(
      print.names.filter(n => n.startsWith('Wpn Name')),
      ['Wpn Name', 'Wpn Name 2', 'Wpn Name 3'],
    );
    // Nine slot tiers, so spells are not the constraint anywhere up to level 20.
    assert.equal(print.names.filter(n => n.startsWith('SlotsTotal')).length, 9);
  },
);

test(
  'the D&D Beyond export is a different vocabulary, not a different edition',
  { skip: !vaultSheet(WIZARD) && 'vault not mounted' },
  () => {
    const blank = new Set(fingerprint(vaultSheet(BLANK)).names);
    const ddb = new Set(fingerprint(vaultSheet(WIZARD)).names);
    assert.equal(ddb.size, 775);
    // Both describe a 2014 character; they agree on 65 names out of 334. A field
    // map that assumed one vocabulary would write to nothing on the other.
    assert.equal([...ddb].filter(n => blank.has(n)).length, 65);
    assert.ok(
      ddb.has('AcrobaticsMod') && ddb.has('AcrobaticsProf'),
      'DDB splits a skill into two boxes',
    );
    assert.ok(
      blank.has('Acrobatics') && !blank.has('AcrobaticsMod'),
      'WotC keeps a skill in one box',
    );
  },
);

test(
  'a real filled sheet yields the character somebody played',
  { skip: !vaultSheet(WIZARD) && 'vault not mounted' },
  () => {
    const fields = fieldMap(vaultSheet(WIZARD));
    assert.equal(fields.CharacterName, 'Elf Wizard');
    assert.equal(fields['CLASS  LEVEL'], 'Wizard 1');
    assert.equal(fields.RACE, 'High Elf');
    assert.equal(fields.BACKGROUND, 'Sage');
    assert.equal(fields.INT, '16');
    assert.equal(fields.INTmod, '+3');
    assert.equal(fields['DEXmod '], '+2', 'the trailing space in the name is real');
    // The escaped brackets a regex reader loses.
    assert.equal(fields['EXPERIENCE POINTS'], '(Milestone)');
  },
);

test(
  'the vault sheets carry a player identity a generated one must not',
  { skip: !vaultSheet(WIZARD) && 'vault not mounted' },
  () => {
    // Not a defect in these — they were exported for a named player. It is the
    // reason the writer has to blank identity fields: a pregen handed to a
    // stranger at a con should carry nobody's account name.
    assert.equal(fieldMap(vaultSheet(WIZARD))['PLAYER NAME'], 'Moon_Knight22250');
  },
);
