#!/usr/bin/env node
// Compile a whole game's vault notes in one pass: every NPCs/*.md with a
// ```statblock fence becomes an actor JSON, every Pregens/*.md with a ```pregen
// fence becomes a player-character actor, every Handouts/*.md with image embeds
// becomes an image journal, and every Scenes/*.md carrying an ambience cue
// stamps that cue onto its scene. This replaces the most manual step in the
// loop — one statblock.mjs / handout.mjs invocation per note.
//
// Usage:
//   node scripts/content/compile-game.mjs "<vault>/03 Oneshots/<Game>" [--force]
//     --force    recompile everything; default skips outputs newer than their note
//     --pool     shared pregen pool the game's Pregens.md draws its party from
//     --pool     shared pregen pool a game's Pregens.md draws from
//
// A drawn pregen's printed sheet is a copy of the pool sheet with this game's
// hooks written onto it. The pool lives in the vault, so a checkout without it
// still compiles everything else.
//
// Only stale notes compile (note mtime > output mtime), so a re-run after
// editing one NPC touches one file. One broken note is reported and does not
// abandon the rest — the per-note error surfaces in the summary and the exit
// code, the same accumulate-then-fail shape as build.mjs.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileNote } from './statblock.mjs';
import { compileHandout, parseFrontmatter, slug } from './handout.mjs';
import { readGameAudio, resolveCue, stampCue } from './cue.mjs';
import { compilePregen, compileSpec, parseFence } from './pregen.mjs';
import { annotateSheet } from './sheet-annotate.mjs';
import { PARTY_NOTE, partyIndexMarkdown, resolveParty } from './pregen-party.mjs';

/**
 * True when `out` is missing or older than any of its inputs.
 *
 * Several inputs rather than one because a pregen drawn from the shared pool
 * has two: the pool note, and the game's own Pregens.md, which is where its
 * hooks live. Checking only the note would let an edited hook table compile to
 * nothing and read as up to date.
 */
async function stale(inputs, out) {
  const sources = Array.isArray(inputs) ? inputs : [inputs];
  try {
    const o = await stat(out);
    const times = await Promise.all(sources.map(s => stat(s)));
    return times.some(t => t.mtimeMs > o.mtimeMs);
  } catch {
    return true; // No output yet, or an input that is not there to compare.
  }
}

async function noteFiles(dir) {
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.md')).sort();
  } catch {
    return []; // The game has no such folder — fine.
  }
}

/**
 * Compile every stale statblock, pregen and handout note under `gameDir`, and
 * stamp every scene note's ambience cue onto the scene it belongs to.
 * Returns { actors, pregens, handouts, cues, errors }; entries carry { note,
 * out, skipped, warnings, deltas }. Errors are per-note strings, never thrown,
 * so one bad note cannot hide the state of the others.
 */
/**
 * The pool sheet a note was read from, and a check that it has not moved.
 *
 * The note is a generated index of that PDF, so the two have to agree. If
 * either side changes, the character described by the note matches neither, and
 * a pregen nobody wrote is worse than no pregen.
 *
 * Returns null when the note names no sheet — a game may author its own pregens
 * rather than draw from the pool, and those have nothing to copy.
 */
export async function poolSheetFor(notePath, spec) {
  if (!spec?.sheet) return null;

  const sheetPath = path.resolve(path.dirname(notePath), spec.sheet);
  let bytes;
  try {
    bytes = await readFile(sheetPath);
  } catch {
    throw new Error(
      `${path.basename(notePath)} was read from ${spec.sheet}, which is not at ${sheetPath}. ` +
        'Pool sheets are root truth and live in the vault; nothing here can rebuild one.',
    );
  }

  if (spec.sheet_sha256) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== spec.sheet_sha256) {
      throw new Error(
        `${path.basename(notePath)} does not match ${spec.sheet} any more ` +
          `(pinned ${spec.sheet_sha256.slice(0, 12)}, found ${actual.slice(0, 12)}). ` +
          'Re-read the pool with pool-from-sheets.mjs so the note describes the sheet again.',
      );
    }
  }

  return { path: sheetPath, bytes };
}

export async function compileGame(gameDir, opts = {}) {
  // <vault>/<section>/<game> — the vault root anchors handout image paths.
  const vault = opts.vault ?? path.dirname(path.dirname(path.resolve(gameDir)));
  const report = { actors: [], pregens: [], handouts: [], cues: [], errors: [] };

  for (const file of await noteFiles(path.join(gameDir, 'NPCs'))) {
    const note = path.join(gameDir, 'NPCs', file);
    const markdown = await readFile(note, 'utf8');
    if (!/```statblock/.test(markdown)) continue; // Prose note, not an NPC sheet.

    const out = path.join(
      gameDir,
      'Foundry',
      'src',
      'actors',
      `${slug(path.basename(file, '.md'))}.json`,
    );
    if (!opts.force && !(await stale(note, out))) {
      report.actors.push({ note, out, skipped: true, warnings: [], deltas: [] });
      continue;
    }
    try {
      const { actor, warnings, deltas, base, exact } = await compileNote(note, {
        reference: opts.reference,
        artMap: opts.artMap,
      });
      if (exact && deltas.length) {
        throw new Error(`exact: true, but ${deltas.length} field(s) diverge from SRD ${base}`);
      }
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(actor, null, 2)}\n`);
      report.actors.push({ note, out, skipped: false, warnings, deltas, base });
    } catch (err) {
      report.errors.push(`${note}: ${err.message}`);
    }
  }

  // Pregens. A third walk rather than a variant of the NPC one, because a
  // player character and a monster are different documents: the fence is
  // different, `verify()` against a published creature is meaningless for a PC,
  // and the Dataview NPC roster would list pregens as monsters if they shared a
  // folder. The `pregen-` prefix keeps them apart in the compendium too.
  //
  // Two sources, in order. A game may draw a party out of the shared pool by
  // naming it in Pregens.md, and it may also keep pregens of its own in
  // Pregens/. The pool is the normal case: a game ships the handful it draws,
  // never the whole pool.
  const pregenNotes = [];
  if (opts.pool) {
    try {
      const party = await resolveParty(gameDir, opts.pool, { vault: opts.vault });
      for (const entry of party?.drawn ?? []) {
        // The hook table is an input too, so editing it rebuilds the character
        // it applies to.
        pregenNotes.push({
          note: entry.note,
          sheet: entry.sheet,
          spec: entry.spec,
          content: entry.content,
          name: entry.name,
          // The hook table is an input too, so editing it rebuilds the
          // character it applies to.
          sources: [entry.source, path.join(gameDir, PARTY_NOTE)],
          slug: entry.slug,
          hooks: entry.hooks,
        });
      }
      if (party) report.party = party;
    } catch (err) {
      report.errors.push(err.message);
    }
  }
  for (const file of await noteFiles(path.join(gameDir, 'Pregens'))) {
    const note = path.join(gameDir, 'Pregens', file);
    const markdown = await readFile(note, 'utf8');
    if (!/```pregen/.test(markdown)) continue; // An index or prose note.
    pregenNotes.push({ note, slug: slug(path.basename(file, '.md')), hooks: [] });
  }

  for (const {
    note,
    sheet: poolSheetPath,
    spec,
    content,
    name: label,
    sources,
    slug: name,
    hooks,
  } of pregenNotes) {
    const out = path.join(gameDir, 'Foundry', 'src', 'actors', `pregen-${name}.json`);
    if (!opts.force && !(await stale(sources ?? note, out))) {
      report.pregens.push({ note, out, skipped: true, warnings: [] });
      continue;
    }
    try {
      const { actor, character, warnings } = spec
        ? await compileSpec(spec, { reference: opts.reference, hooks, name: label, content })
        : await compilePregen(note, { reference: opts.reference, hooks });
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(actor, null, 2)}\n`);

      // The printable half. The pool sheet IS the printable character — it was
      // built by hand in D&D Beyond at the level it is for — so a game takes a
      // copy and writes its own hooks onto it. Nothing is regenerated: printing
      // the character afresh would mean reproducing 775 fields in order to add
      // one, and every field missed would be a gap on a sheet that looks
      // finished.
      //
      // Skipped silently when the pool note names no sheet, so a game whose
      // pregens are authored rather than drawn still compiles.
      let sheet = null;
      const poolSheet = poolSheetPath
        ? { bytes: await readFile(poolSheetPath) }
        : await poolSheetFor(note, parseFence(await readFile(note, 'utf8')));
      if (poolSheet) {
        const { bytes } = await annotateSheet(poolSheet.bytes, hooks, {
          game: path.basename(gameDir),
        });
        sheet = path.join(gameDir, 'Pregens', `${name}.pdf`);
        await mkdir(path.dirname(sheet), { recursive: true });
        await writeFile(sheet, bytes);
      }

      report.pregens.push({ note, out, sheet, skipped: false, warnings, character, hooks });
    } catch (err) {
      report.errors.push(`${note}: ${err.message}`);
    }
  }

  // A roster of what was actually built, in the format Dragons of Stormwreck
  // Isle keeps by hand. Written beside the sheets rather than into the game's
  // own Pregens.md, which is an authored file holding the party declaration —
  // generating over the top of it would eat the hooks it declares.
  if (report.party?.drawn?.length) {
    const index = path.join(gameDir, 'Pregens', 'index.md');
    await mkdir(path.dirname(index), { recursive: true });
    await writeFile(
      index,
      partyIndexMarkdown(report.party.drawn, { game: path.basename(gameDir) }),
    );
    report.partyIndex = index;
  }

  for (const file of await noteFiles(path.join(gameDir, 'Handouts'))) {
    const note = path.join(gameDir, 'Handouts', file);
    const out = path.join(
      gameDir,
      'Foundry',
      'src',
      'journals',
      `${slug(path.basename(file, '.md'))}-art.json`,
    );
    if (!opts.force && !(await stale(note, out))) {
      report.handouts.push({ note, out, skipped: true });
      continue;
    }
    try {
      const { journal, resolved, unresolved } = await compileHandout(note, { vault });
      if (unresolved.length) {
        throw new Error(`could not find embedded image(s): ${unresolved.join(', ')}`);
      }
      if (!resolved.length) continue; // Prose handout — the bridge's business.
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(journal, null, 2)}\n`);
      report.handouts.push({ note, out, skipped: false, pages: resolved.length });
    } catch (err) {
      report.errors.push(`${note}: ${err.message}`);
    }
  }

  // Ambience cues. Deliberately not mtime-gated like the passes above: the
  // scene JSON is both the input and the output here, and regenerating a map
  // through dd2vtt-to-scene.mjs writes a fresh file with no cue on it. A
  // mtime check would call that file current and silently drop the cue, so
  // the cue is recomputed every run and written only when it differs.
  const game = await readGameAudio(gameDir);
  for (const file of await noteFiles(path.join(gameDir, 'Scenes'))) {
    const note = path.join(gameDir, 'Scenes', file);
    const out = path.join(
      gameDir,
      'Foundry',
      'src',
      'scenes',
      `${slug(path.basename(file, '.md'))}.json`,
    );
    try {
      const audio = resolveCue(parseFrontmatter(await readFile(note, 'utf8')), game);
      if (!audio) continue; // No cue yet, or silence on purpose.

      let scene;
      try {
        scene = JSON.parse(await readFile(out, 'utf8'));
      } catch {
        // A scene note routinely lands before its map does. Say so and move
        // on — the cue is not lost, it stamps on the next run.
        report.cues.push({ note, out, skipped: true, warning: 'no scene JSON yet' });
        continue;
      }

      const { scene: stamped, changed } = stampCue(scene, audio);
      if (!changed) {
        report.cues.push({ note, out, skipped: true });
        continue;
      }
      await writeFile(out, `${JSON.stringify(stamped, null, 2)}\n`);
      report.cues.push({ note, out, skipped: false, cue: audio.cue });
    } catch (err) {
      report.errors.push(`${note}: ${err.message}`);
    }
  }

  return report;
}

function parseArgs(argv) {
  const opts = { force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') opts.force = true;
    else if (argv[i] === '--vault') opts.vault = argv[++i];
    // Accepted and ignored: a pregen's sheet is now a copy of its pool sheet
    // rather than a fresh print onto a publisher blank. Kept so an existing
    // invocation does not fail on an unknown argument.
    else if (argv[i] === '--sheets') argv[++i];
    else if (argv[i] === '--pool') opts.pool = argv[++i];
    else if (argv[i] === '--template') argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`Unknown argument: ${argv[i]}`);
    else rest.push(argv[i]);
  }
  if (!rest.length)
    throw new Error('Missing <game dir> (e.g. "$DND_VAULT_PATH/03 Oneshots/My Game")');
  opts.gameDir = rest[0];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await compileGame(opts.gameDir, opts);

  for (const a of report.actors) {
    console.log(`${a.skipped ? 'fresh ' : 'actor '} ${path.relative(opts.gameDir, a.out)}`);
    for (const w of a.warnings) console.warn(`  warning: ${w}`);
    for (const d of a.deltas) {
      console.warn(`  delta vs SRD ${a.base}: ${d.field} authored ${d.authored}, SRD ${d.srd}`);
    }
  }
  for (const p of report.pregens) {
    const who = p.character ? ` (${p.character.className} ${p.character.level})` : '';
    console.log(`${p.skipped ? 'fresh ' : 'pregen'} ${path.relative(opts.gameDir, p.out)}${who}`);
    if (p.sheet) console.log(`        ${path.relative(opts.gameDir, p.sheet)}`);
    for (const w of p.warnings) console.warn(`  warning: ${w}`);
  }
  for (const h of report.handouts) {
    console.log(`${h.skipped ? 'fresh ' : 'journal'} ${path.relative(opts.gameDir, h.out)}`);
  }
  for (const c of report.cues) {
    // A warned cue is neither written nor current, so it must not read "fresh".
    const label = c.warning ? 'no cue' : c.skipped ? 'fresh ' : 'cue   ';
    console.log(`${label} ${path.relative(opts.gameDir, c.out)}`);
    if (c.warning) console.warn(`  warning: ${c.warning}`);
  }
  for (const e of report.errors) console.error(`FAIL ${e}`);
  if (report.errors.length) {
    throw new Error(`${report.errors.length} note(s) failed to compile`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
