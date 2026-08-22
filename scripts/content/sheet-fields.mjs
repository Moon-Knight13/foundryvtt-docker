#!/usr/bin/env node
// Read the AcroForm fields out of a fillable character sheet PDF, so a pregen
// can be checked against — and later written onto — the sheet a player is
// actually handed.
//
// This is the read half of the pair, and it exists before the write half on
// purpose:
//
//   sheet-fields.mjs (this file)  "what does this form call its boxes, and
//                                  what is in them?"
//   the writer (Story 5)          "put these derived numbers in those boxes"
//
// Reading first buys a correctness oracle for free. The vault already holds
// five finished level-1 characters as filled PDFs (Dragons of Stormwreck Isle,
// `Pregens/`). Once they can be parsed, every later stage can be graded against
// real characters somebody actually played, instead of against a fixture
// invented alongside the code it is meant to check.
//
// Two facts about sheet PDFs drive the design, both measured rather than
// assumed (2026-08-22):
//
//   * Field names belong to the FORM, not to the edition. The WotC official
//     fillable sheet has 334 fields (`Alignment`, `Acrobatics`); the D&D Beyond
//     PDF export of the same 2014 character has 775 (`ALIGNMENT`, and
//     `AcrobaticsMod` + `AcrobaticsProf` as separate boxes). They share 65
//     names. So nothing here may hardcode a field name — callers map names
//     per template, and this module only reports what it finds.
//     (A regex over the bytes says 336, because the WotC sheet carries two
//     deleted fields its form no longer lists. Walking the form is the
//     difference between counting boxes and counting leftovers.)
//   * The names carry whitespace that looks like a typo and is not: `Race `,
//     `DEXmod `, `Deception `, `Wpn3 AtkBonus  ` (two trailing spaces),
//     `SpellSaveDC  2` (two internal). Never retype a field name. Extract it.
//
// No dependency: the parser below is enough to read these files, and adding a
// PDF library for the read side would mean a build-time dependency on the one
// step that most needs to keep working offline.
//
// Usage:
//   node scripts/content/sheet-fields.mjs <sheet.pdf> [--json|--names|--filled]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateSync, inflateRawSync } from 'node:zlib';

// --------------------------------------------------------------------------
// PDF object model
//
// Three wrapper classes, because a PDF name, a PDF string and a reference all
// arrive as text and mean different things. Collapsing them to JS strings
// early is what makes naive PDF readers mis-report `/Off` as the text "Off".
// --------------------------------------------------------------------------

/** A PDF name — `/Tx`, `/Widget`. `value` excludes the slash. */
export class PdfName {
  constructor(value) {
    this.value = value;
  }
}

/** A PDF string. Kept as bytes: the encoding is not knowable until decode. */
export class PdfString {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

/** An indirect reference — `12 0 R`. */
export class PdfRef {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

/** Returned when the lexer meets a closing delimiter it was not looking for. */
const END = Symbol('end');

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWhitespace = byte => WHITESPACE.has(byte);
const isDelimiter = byte => DELIMITERS.has(byte);
const isRegular = byte => byte !== undefined && !isWhitespace(byte) && !isDelimiter(byte);

/**
 * A recursive-descent reader over one buffer.
 *
 * It is deliberately forgiving. A sheet that has been through a form filler,
 * a printer driver and a cloud storage round-trip is often not spec-clean, and
 * refusing to read a slightly malformed file would fail on exactly the real
 * sheets this exists to read.
 */
class Lexer {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipWhitespace() {
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos];
      if (isWhitespace(byte)) {
        this.pos += 1;
      } else if (byte === 0x25) {
        // A comment runs to the end of the line.
        while (
          this.pos < this.buf.length &&
          this.buf[this.pos] !== 0x0a &&
          this.buf[this.pos] !== 0x0d
        ) {
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  /** Parse one object. Returns END at a stray `]` or `>>`. */
  parseObject() {
    this.skipWhitespace();
    if (this.pos >= this.buf.length) return END;
    const byte = this.buf[this.pos];

    if (byte === 0x2f) return this.parseName();
    if (byte === 0x28) return this.parseLiteralString();
    if (byte === 0x5b) return this.parseArray();
    if (byte === 0x3c) {
      return this.buf[this.pos + 1] === 0x3c ? this.parseDictionary() : this.parseHexString();
    }
    if (byte === 0x5d || byte === 0x3e || byte === 0x29 || byte === 0x7d) {
      this.pos += 1;
      if (byte === 0x3e && this.buf[this.pos] === 0x3e) this.pos += 1;
      return END;
    }
    return this.parseKeyword();
  }

  parseName() {
    this.pos += 1; // the slash
    let out = '';
    while (isRegular(this.buf[this.pos])) {
      const ch = this.buf[this.pos];
      if (ch === 0x23 && this.pos + 2 < this.buf.length) {
        // `#xx` escapes let a name hold a space or a slash.
        const hex = this.buf.toString('latin1', this.pos + 1, this.pos + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(ch);
      this.pos += 1;
    }
    return new PdfName(out);
  }

  parseLiteralString() {
    this.pos += 1; // the open paren
    const bytes = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos];
      if (byte === 0x5c) {
        // Backslash escapes. `\(` is why a naive `/V \(([^)]*)\)` regex
        // truncates any value containing a bracket — "(Milestone)" for one.
        this.pos += 1;
        const esc = this.buf[this.pos];
        this.pos += 1;
        if (esc === undefined) break;
        const simple = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
        if (esc in simple) {
          bytes.push(simple[esc]);
        } else if (esc >= 0x30 && esc <= 0x37) {
          let octal = String.fromCharCode(esc);
          while (octal.length < 3 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37) {
            octal += String.fromCharCode(this.buf[this.pos]);
            this.pos += 1;
          }
          bytes.push(parseInt(octal, 8) & 0xff);
        } else if (esc === 0x0a) {
          // A backslash before a newline is a line continuation: emit nothing.
        } else if (esc === 0x0d) {
          if (this.buf[this.pos] === 0x0a) this.pos += 1;
        } else {
          bytes.push(esc);
        }
        continue;
      }
      if (byte === 0x28) depth += 1;
      if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          break;
        }
      }
      bytes.push(byte);
      this.pos += 1;
    }
    return new PdfString(Buffer.from(bytes));
  }

  parseHexString() {
    this.pos += 1; // the `<`
    let hex = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(this.buf[this.pos]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      this.pos += 1;
    }
    this.pos += 1; // the `>`
    if (hex.length % 2) hex += '0'; // an odd digit count means a trailing zero
    return new PdfString(Buffer.from(hex, 'hex'));
  }

  parseArray() {
    this.pos += 1; // the `[`
    const out = [];
    while (this.pos < this.buf.length) {
      this.skipWhitespace();
      if (this.buf[this.pos] === 0x5d) {
        this.pos += 1;
        break;
      }
      const value = this.parseObject();
      if (value === END) break;
      out.push(value);
    }
    return out;
  }

  parseDictionary() {
    this.pos += 2; // the `<<`
    const dict = new Map();
    while (this.pos < this.buf.length) {
      this.skipWhitespace();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.buf[this.pos] !== 0x2f) {
        // Not a key. Something is malformed; step over it rather than spin.
        const skipped = this.parseObject();
        if (skipped === END) break;
        continue;
      }
      const key = this.parseName().value;
      const value = this.parseObject();
      if (value === END) break;
      dict.set(key, value);
    }
    return dict;
  }

  /** Numbers, references, and the three keywords. */
  parseKeyword() {
    const start = this.pos;
    while (isRegular(this.buf[this.pos])) this.pos += 1;
    const token = this.buf.toString('latin1', start, this.pos);
    if (token === '') {
      this.pos += 1; // never spin on an unexpected byte
      return null;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;

    if (/^[+-]?\d+$/.test(token)) {
      // `12 0 R` is a reference; `12 0` followed by anything else is a number
      // that happens to sit before another number.
      const save = this.pos;
      this.skipWhitespace();
      const genStart = this.pos;
      while (isRegular(this.buf[this.pos])) this.pos += 1;
      const gen = this.buf.toString('latin1', genStart, this.pos);
      if (/^\d+$/.test(gen)) {
        this.skipWhitespace();
        if (this.buf[this.pos] === 0x52 && !isRegular(this.buf[this.pos + 1])) {
          this.pos += 1;
          return new PdfRef(Number(token), Number(gen));
        }
      }
      this.pos = save;
      return Number(token);
    }
    const numeric = Number(token);
    return Number.isNaN(numeric) ? new PdfName(token) : numeric;
  }
}

// --------------------------------------------------------------------------
// Streams
// --------------------------------------------------------------------------

/**
 * Undo a PNG row predictor.
 *
 * Compressed object streams sometimes carry one. Without this the inflate
 * succeeds and the bytes are subtly wrong, which reads as a corrupt file
 * rather than as an unhandled filter — the worse of the two failures.
 */
function undoPngPredictor(data, colors, bitsPerComponent, columns) {
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowLength = Math.ceil((colors * bitsPerComponent * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let r = 0; r < rows; r += 1) {
    const tag = data[r * (rowLength + 1)];
    const row = Buffer.from(data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1)));
    for (let i = 0; i < rowLength; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value = row[i];
      if (tag === 1) value += left;
      else if (tag === 2) value += up;
      else if (tag === 3) value += Math.floor((left + up) / 2);
      else if (tag === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[i] = value & 0xff;
    }
    row.copy(out, r * rowLength);
    previous = row;
  }
  return out;
}

/** Inflate one stream. Returns null for a filter this does not implement. */
function decodeStream(dict, raw, resolve) {
  const filter = resolve(dict.get('Filter'));
  const filters = filter instanceof PdfName ? [filter] : Array.isArray(filter) ? filter : [];
  if (filters.length === 0) return raw;
  if (
    !filters.every(f => f instanceof PdfName && (f.value === 'FlateDecode' || f.value === 'Fl'))
  ) {
    return null;
  }

  let data;
  try {
    data = inflateSync(raw);
  } catch {
    try {
      data = inflateRawSync(raw);
    } catch {
      return null;
    }
  }

  const parmsValue = resolve(dict.get('DecodeParms')) ?? resolve(dict.get('DP'));
  const parms = Array.isArray(parmsValue) ? resolve(parmsValue[0]) : parmsValue;
  if (parms instanceof Map) {
    const predictor = resolve(parms.get('Predictor')) ?? 1;
    if (predictor >= 10) {
      data = undoPngPredictor(
        data,
        resolve(parms.get('Colors')) ?? 1,
        resolve(parms.get('BitsPerComponent')) ?? 8,
        resolve(parms.get('Columns')) ?? 1,
      );
    }
  }
  return data;
}

// --------------------------------------------------------------------------
// Document
// --------------------------------------------------------------------------

/**
 * Read every indirect object in the file, including those hidden inside
 * compressed object streams.
 *
 * This scans for `N G obj` rather than following the cross-reference table.
 * That is the right trade for this job: an incrementally-saved sheet (which is
 * what a form filler produces) has several xref sections and any of them can be
 * stale, whereas the object headers are always there. Later definitions win,
 * matching how an incremental update is meant to be read.
 */
export function parseDocument(buf) {
  const objects = new Map();
  const streams = new Map();
  const text = buf.toString('latin1');

  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = header.exec(text)) !== null) {
    const num = Number(match[1]);
    const lexer = new Lexer(buf, match.index + match[0].length);
    let value;
    try {
      value = lexer.parseObject();
    } catch {
      continue;
    }
    if (value === END) continue;
    objects.set(num, value);

    lexer.skipWhitespace();
    if (buf.toString('latin1', lexer.pos, lexer.pos + 6) === 'stream') {
      let start = lexer.pos + 6;
      if (buf[start] === 0x0d) start += 1;
      if (buf[start] === 0x0a) start += 1;
      // Trust /Length only when it is a direct integer; otherwise find the
      // terminator, which is what a recovery parser has to do anyway.
      const declared = value instanceof Map ? value.get('Length') : null;
      let end;
      if (typeof declared === 'number' && declared >= 0 && start + declared <= buf.length) {
        end = start + declared;
        const after = buf.toString('latin1', end, end + 20);
        if (!/^\s*endstream/.test(after)) end = text.indexOf('endstream', start);
      } else {
        end = text.indexOf('endstream', start);
      }
      if (end > start) streams.set(num, { dict: value, raw: buf.subarray(start, end) });
    }
  }

  const resolve = value => (value instanceof PdfRef ? objects.get(value.num) : value);

  // Object streams hold most of the form in a modern file. Until they are
  // expanded, a scan of the raw bytes finds no /AcroForm at all — which is
  // exactly how a fillable sheet can look flattened when it is not.
  for (const [, { dict, raw }] of streams) {
    const type = resolve(dict.get('Type'));
    if (!(type instanceof PdfName) || type.value !== 'ObjStm') continue;
    const data = decodeStream(dict, raw, resolve);
    if (!data) continue;
    const count = resolve(dict.get('N'));
    const first = resolve(dict.get('First'));
    if (typeof count !== 'number' || typeof first !== 'number') continue;

    const headerLexer = new Lexer(data, 0);
    const pairs = [];
    for (let i = 0; i < count; i += 1) {
      const num = headerLexer.parseObject();
      const offset = headerLexer.parseObject();
      if (typeof num !== 'number' || typeof offset !== 'number') break;
      pairs.push([num, offset]);
    }
    for (const [num, offset] of pairs) {
      try {
        const value = new Lexer(data, first + offset).parseObject();
        if (value !== END) objects.set(num, value);
      } catch {
        // One unreadable entry must not cost the rest of the stream.
      }
    }
  }

  return { objects, streams, resolve };
}

/**
 * Decode a PDF string to JS text.
 *
 * Sheet values arrive in two encodings and guessing wrong turns a name into
 * mojibake: UTF-16BE when the filler wrote one (marked by a byte-order mark),
 * PDFDocEncoding otherwise.
 */
export function decodePdfString(value) {
  if (!(value instanceof PdfString)) return null;
  const { bytes } = value;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    if (body.length % 2) return body.toString('latin1');
    return body.swap16().toString('utf16le');
  }
  return bytes.toString('latin1');
}

const FIELD_TYPES = { Tx: 'text', Btn: 'button', Ch: 'choice', Sig: 'signature' };

/**
 * Every form field in the file, in discovery order.
 *
 * Fields are returned once each, not once per widget. A name that appears on
 * three pages — `Wpn Name` does — is one field whose value shows in three
 * places, which is AcroForm's own semantics and is the reason a generated
 * sheet only needs to set it once.
 */
export function readFields(buf) {
  const { objects, resolve } = parseDocument(buf);

  const catalog = [...objects.values()].find(o => {
    if (!(o instanceof Map)) return false;
    const type = resolve(o.get('Type'));
    return type instanceof PdfName && type.value === 'Catalog';
  });
  const acroForm = catalog ? resolve(catalog.get('AcroForm')) : null;

  const roots = [];
  const fromAcroForm = acroForm instanceof Map ? resolve(acroForm.get('Fields')) : null;
  if (Array.isArray(fromAcroForm) && fromAcroForm.length > 0) {
    roots.push(...fromAcroForm);
  } else {
    // No usable /AcroForm. Fall back to every object that names itself a
    // field, so a sheet with a damaged catalog still reads.
    for (const [num, value] of objects) {
      if (value instanceof Map && (value.has('T') || value.has('FT')))
        roots.push(new PdfRef(num, 0));
    }
  }

  const fields = new Map();
  const seen = new Set();

  const inherited = (dict, key, depth = 0) => {
    if (!(dict instanceof Map) || depth > 32) return undefined;
    if (dict.has(key)) return resolve(dict.get(key));
    return inherited(resolve(dict.get('Parent')), key, depth + 1);
  };

  const qualifiedName = (dict, depth = 0) => {
    if (!(dict instanceof Map) || depth > 32) return '';
    const own = dict.has('T') ? decodePdfString(resolve(dict.get('T'))) : null;
    const parent = qualifiedName(resolve(dict.get('Parent')), depth + 1);
    if (own === null) return parent;
    return parent ? `${parent}.${own}` : own;
  };

  const walk = (node, depth = 0) => {
    if (depth > 64) return;
    const key = node instanceof PdfRef ? `R${node.num}` : null;
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    const dict = resolve(node);
    if (!(dict instanceof Map)) return;

    // A node is a field if it names itself. Its kids may be widgets (which
    // share the name) or further fields (which extend it).
    if (dict.has('T')) {
      const name = qualifiedName(dict);
      if (name && !fields.has(name)) {
        const ft = inherited(dict, 'FT');
        const rawValue = inherited(dict, 'V');
        let value = null;
        if (rawValue instanceof PdfString) value = decodePdfString(rawValue);
        else if (rawValue instanceof PdfName) value = rawValue.value;
        else if (typeof rawValue === 'number') value = String(rawValue);
        fields.set(name, {
          name,
          type: ft instanceof PdfName ? FIELD_TYPES[ft.value] ?? 'unknown' : 'unknown',
          value,
        });
      }
    }
    const kids = resolve(dict.get('Kids'));
    if (Array.isArray(kids)) for (const kid of kids) walk(kid, depth + 1);
  };

  for (const root of roots) walk(root);
  return [...fields.values()];
}

/** Field name to value, for callers that only want the filled-in text. */
export function fieldMap(buf) {
  const out = {};
  for (const field of readFields(buf)) out[field.name] = field.value;
  return out;
}

/**
 * What a template registry entry needs to pin one blank form.
 *
 * The checksum is the point: if a publisher reissues the sheet with renamed
 * boxes, every generated PDF would otherwise keep building and come out blank
 * in the renamed places. Pinning turns that into a build failure.
 */
export function fingerprint(buf) {
  const fields = readFields(buf);
  const filled = fields.filter(f => f.value !== null && f.value !== '' && f.value !== 'Off');
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    fieldCount: fields.length,
    filledCount: filled.length,
    names: fields.map(f => f.name).sort(),
  };
}

async function main(argv) {
  const files = argv.filter(a => !a.startsWith('--'));
  const mode = argv.find(a => a.startsWith('--')) ?? '--filled';
  if (files.length !== 1) {
    console.error('usage: sheet-fields.mjs <sheet.pdf> [--json|--names|--filled|--fingerprint]');
    return 1;
  }
  const buf = await readFile(files[0]);

  if (mode === '--fingerprint') {
    const { names, ...rest } = fingerprint(buf);
    console.log(JSON.stringify(rest, null, 2));
    return 0;
  }
  const fields = readFields(buf);
  if (mode === '--json') {
    console.log(JSON.stringify(fields, null, 2));
  } else if (mode === '--names') {
    for (const field of fields) console.log(field.name);
  } else {
    for (const field of fields) {
      if (field.value && field.value !== 'Off') console.log(`${field.name}\t${field.value}`);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
