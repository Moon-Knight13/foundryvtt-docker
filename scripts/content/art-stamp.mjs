#!/usr/bin/env node
// Write the art resolver's map picks back into the notes, so Obsidian shows
// the same icon Foundry will. The compiler resolves mook art invisibly — the
// note stays blank in the vault even though the token ships fine. Stamping
// makes the pick visible where the author reads: an explicit `image:` line,
// vault-relative so Obsidian's statblock plugin can render it (the compiler
// owns the DnD/ mount prefix — see normalizeArtPath).
//
// What may be stamped is deliberately narrow:
//   exact/type  map picks that live in the vault — stamped
//   explicit    the author already chose — never rewritten
//   srd         real SRD art under systems/… Obsidian cannot see — left alone
//   none        a named NPC's visible gap — left alone, that gap is the point
//
// Usage:
//   node scripts/content/art-stamp.mjs "<vault>/03 Oneshots/<Game>"
import path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileNote } from './statblock.mjs';
import { GENERIC_ART_DIR } from './art-resolve.mjs';

/**
 * Insert `image: <vaultRelative>` on the line after `name:` inside the note's
 * statblock fence. Returns the stamped markdown, or null when the fence
 * already carries an image: line (an author's choice is never rewritten).
 */
export function stampFence(markdown, vaultRelative) {
  const fence = markdown.match(/```statblock\n([\s\S]*?)```/);
  if (!fence || /^image:/m.test(fence[1])) return null;
  const body = fence[1].replace(/^(name:[^\n]*\n)/m, `$1image: ${vaultRelative}\n`);
  if (body === fence[1]) return null; // No name: line to anchor on — leave it.
  return markdown.replace(fence[0], '```statblock\n' + body + '```');
}

/**
 * Stamp every NPC note under `gameDir` whose art resolved from the curated
 * map. Returns { stamped, skipped, errors }; nothing else is modified.
 */
export async function stampGame(gameDir, opts = {}) {
  const report = { stamped: [], skipped: [], errors: [] };
  const dir = path.join(gameDir, 'NPCs');
  let files = [];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.md')).sort();
  } catch {
    return report; // The game has no NPCs folder — nothing to stamp.
  }

  for (const file of files) {
    const note = path.join(dir, file);
    const markdown = await readFile(note, 'utf8');
    if (!/```statblock/.test(markdown)) continue; // Prose note.
    try {
      const { art } = await compileNote(note, opts);
      const fromMap =
        (art.tier === 'exact' || art.tier === 'type') && art.src?.startsWith(`${GENERIC_ART_DIR}/`);
      if (!fromMap) {
        report.skipped.push({ note, tier: art.tier });
        continue;
      }
      // Strip the Foundry mount prefix: the note wants the vault-relative form.
      const stamped = stampFence(markdown, art.src.replace(/^DnD\//, ''));
      if (!stamped) {
        report.skipped.push({ note, tier: art.tier });
        continue;
      }
      await writeFile(note, stamped);
      report.stamped.push({ note, src: art.src, tier: art.tier });
    } catch (err) {
      report.errors.push(`${note}: ${err.message}`);
    }
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const gameDir = args.find(a => !a.startsWith('--'));
  if (!gameDir) {
    console.error('Usage: art-stamp.mjs "<vault>/03 Oneshots/<Game>"');
    process.exit(2);
  }
  const report = await stampGame(gameDir);
  for (const s of report.stamped) console.log(`stamped  ${path.basename(s.note)}  ${s.src}`);
  for (const s of report.skipped) console.log(`skip     ${path.basename(s.note)}  (${s.tier})`);
  for (const e of report.errors) console.error(`error    ${e}`);
  if (!report.stamped.length && !report.skipped.length) console.log('nothing to stamp');
  process.exit(report.errors.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
