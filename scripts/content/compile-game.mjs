#!/usr/bin/env node
// Compile a whole game's vault notes in one pass: every NPCs/*.md with a
// ```statblock fence becomes an actor JSON, every Handouts/*.md with image
// embeds becomes an image journal. This replaces the most manual step in the
// loop — one statblock.mjs / handout.mjs invocation per note.
//
// Usage:
//   node scripts/content/compile-game.mjs "<vault>/03 Oneshots/<Game>" [--force]
//     --force  recompile everything; default skips outputs newer than their note
//
// Only stale notes compile (note mtime > output mtime), so a re-run after
// editing one NPC touches one file. One broken note is reported and does not
// abandon the rest — the per-note error surfaces in the summary and the exit
// code, the same accumulate-then-fail shape as build.mjs.
import path from 'node:path';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileNote } from './statblock.mjs';
import { compileHandout, slug } from './handout.mjs';

/** True when `out` is missing or older than `note`. */
async function stale(note, out) {
  try {
    const [n, o] = [await stat(note), await stat(out)];
    return n.mtimeMs > o.mtimeMs;
  } catch {
    return true; // No output yet.
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
 * Compile every stale statblock and handout note under `gameDir`.
 * Returns { actors, handouts, errors }; entries carry { note, out, skipped,
 * warnings, deltas }. Errors are per-note strings, never thrown, so one bad
 * note cannot hide the state of the others.
 */
export async function compileGame(gameDir, opts = {}) {
  // <vault>/<section>/<game> — the vault root anchors handout image paths.
  const vault = opts.vault ?? path.dirname(path.dirname(path.resolve(gameDir)));
  const report = { actors: [], handouts: [], errors: [] };

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

  return report;
}

function parseArgs(argv) {
  const opts = { force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') opts.force = true;
    else if (argv[i] === '--vault') opts.vault = argv[++i];
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
  for (const h of report.handouts) {
    console.log(`${h.skipped ? 'fresh ' : 'journal'} ${path.relative(opts.gameDir, h.out)}`);
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
