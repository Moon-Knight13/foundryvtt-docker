#!/usr/bin/env node
// Write a game's hooks onto a copy of a pool sheet, so the PDF a player is
// handed at an in-person table carries that game's colour without the pool
// sheet ever being touched.
//
// This replaces printing onto a publisher blank. The pool holds finished D&D
// Beyond exports — the character already exists on paper, complete, at the
// level it was built for. Regenerating that onto an empty form would mean
// reproducing 775 fields' worth of work in order to change two of them, and
// every field we failed to reproduce would be a gap on a sheet that looks
// finished. Annotating a copy changes what we mean to change and nothing else.
//
// Two facts about D&D Beyond exports drive the implementation, both measured
// rather than assumed (2026-08-24, `human_fighter_lv1.pdf`):
//
//   * There is NO /AcroForm entry in the catalog. All 775 fields exist only as
//     widget annotations on the pages, so pdf-lib's form API sees zero fields
//     until an AcroForm is synthesized from those widgets. (`sheet-fields.mjs`
//     reads them anyway, because it scans objects rather than trusting the
//     form.)
//   * Each field carries its own default appearance — `0 g /Helvetica 7 Tf` —
//     and the multiline flag. That is why text written here renders at 7pt
//     rather than being scaled to fill its box. The 66-point text seen when
//     printing onto the WotC blank comes from that form's `/Helv 0 Tf`, which
//     means auto-size, with no per-field override.
//
// Hence the two rules below, both load-bearing:
//
//   * synthesize the AcroForm before touching the form API
//   * never call `form.updateFieldAppearances()`. It regenerates every field on
//     the sheet; writing one field regenerates only that field, from the /DA
//     the publisher already set.
//
// Usage:
//   node scripts/content/sheet-annotate.mjs <pool sheet.pdf> --out <copy.pdf>
//     [--text "..."]... [--box Backstory]
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';

/**
 * Free-text boxes on the D&D Beyond export, in the order they are claimed.
 *
 * Backstory first because that is where a reader looks for who this character
 * is to this story. The rest are fallbacks for a character whose export already
 * filled the earlier ones — a pool sheet is authored elsewhere and may legally
 * carry any of these.
 */
export const NOTE_BOXES = [
  'Backstory',
  'AdditionalNotes1',
  'AdditionalNotes2',
  'AlliesOrganizations',
];

/**
 * Make the form API able to see fields that exist only as widget annotations.
 *
 * Returns the number of widgets registered, or 0 when the document already
 * carries an AcroForm and needs no help. Registering is additive: it introduces
 * a dictionary the file was missing rather than altering any field.
 */
export function synthesizeAcroForm(pdf) {
  // An AcroForm that already lists fields is the document's own and is left
  // alone. An EMPTY one is not evidence of anything: pdf-lib's getForm()
  // creates one as a side effect of being called, so a caller that looked at
  // the form before calling this would otherwise have silently disabled it.
  const existing = pdf.catalog.lookup(PDFName.of('AcroForm'));
  if (existing) {
    const fields = existing.lookup?.(PDFName.of('Fields'));
    if (fields instanceof PDFArray && fields.size() > 0) return 0;
  }

  const refs = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) refs.push(annots.get(i));
  }
  if (!refs.length) return 0;

  if (existing) {
    existing.set(PDFName.of('Fields'), pdf.context.obj(refs));
  } else {
    const acroForm = pdf.context.obj({ Fields: refs });
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.register(acroForm));
  }
  return refs.length;
}

/** The text a hook contributes to the sheet. */
export function noteText(hooks = [], { game } = {}) {
  if (!hooks.length) return '';
  const heading = game ? `${game} — your part in it` : 'Your part in it';
  return [heading, '', ...hooks.map(h => `* ${h}`)].join('\n');
}

/**
 * Choose which box to write into.
 *
 * Never overwrites a box the source sheet already filled. A pool sheet is
 * authored by hand in D&D Beyond and its prose belongs to whoever wrote it;
 * silently replacing a backstory with a hook would lose authored work and look
 * like the tool had eaten it.
 */
export function pickBox(form, boxes = NOTE_BOXES) {
  const problems = [];
  for (const name of boxes) {
    let field;
    try {
      field = form.getTextField(name);
    } catch {
      problems.push(`${name} (no such field)`);
      continue;
    }
    const existing = (field.getText() ?? '').trim();
    if (!existing) return { name, field };
    problems.push(`${name} (already filled)`);
  }
  throw new Error(
    `No free text box on this sheet to write into: ${problems.join(', ')}. ` +
      'Clear one in D&D Beyond and re-export, or the hook has nowhere to go.',
  );
}

/**
 * Write values onto a copy of a sheet and return the new bytes.
 *
 * `values` is a flat name -> text object, matching sheetValues() in
 * sheet-write.mjs so the two can be compared field for field.
 */
export async function annotate(sheetBytes, values) {
  const pdf = await PDFDocument.load(sheetBytes);
  synthesizeAcroForm(pdf);
  const form = pdf.getForm();

  const present = new Set(form.getFields().map(f => f.getName()));
  const missing = Object.keys(values).filter(name => !present.has(name));
  if (missing.length) {
    throw new Error(
      `The sheet has no field named ${missing.map(m => JSON.stringify(m)).join(', ')}. ` +
        'Field names are extracted, never typed — read them with sheet-fields.mjs --names.',
    );
  }

  for (const [name, value] of Object.entries(values)) {
    form.getTextField(name).setText(String(value));
  }
  // Deliberately NOT form.updateFieldAppearances(). See the header.
  //
  // A Buffer rather than the Uint8Array pdf.save() returns: sheet-fields.mjs
  // reads Buffers, and handed a bare Uint8Array it reports a document with
  // zero fields rather than failing, which is the worst way to be wrong.
  return Buffer.from(await pdf.save());
}

/** Put a game's hooks onto a copy of a pool sheet. */
export async function annotateSheet(sheetBytes, hooks, { game, boxes } = {}) {
  const text = noteText(hooks, { game });
  if (!text) return { bytes: sheetBytes, box: null, text: '' };

  const pdf = await PDFDocument.load(sheetBytes);
  synthesizeAcroForm(pdf);
  const { name } = pickBox(pdf.getForm(), boxes);
  return { bytes: await annotate(sheetBytes, { [name]: text }), box: name, text };
}

export function parseArgs(argv) {
  const opts = { sheets: [], text: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--text') opts.text.push(argv[++i]);
    else if (a === '--box') opts.box = argv[++i];
    else if (a === '--game') opts.game = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.sheets.push(a);
  }
  if (opts.sheets.length !== 1 || !opts.out) {
    throw new Error('usage: sheet-annotate.mjs <sheet.pdf> --out <copy.pdf> [--text "..."]');
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const source = await readFile(opts.sheets[0]);
  const { bytes, box } = await annotateSheet(source, opts.text, {
    game: opts.game,
    boxes: opts.box ? [opts.box] : undefined,
  });
  await writeFile(opts.out, bytes);
  console.log(
    `${opts.out}: ${opts.text.length} hook(s) into ${box ?? 'no box (nothing to write)'}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
