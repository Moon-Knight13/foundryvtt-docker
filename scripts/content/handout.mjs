#!/usr/bin/env node
// Turn a vault handout note's embedded images into a Foundry journal of image
// pages, so the GM can right-click -> "Show to Players" and players can reopen
// them afterwards.
//
// IMAGES ONLY, deliberately. The vault's own rule is that a journal is owned by
// one pipe — the SoSly Obsidian Bridge (prose) or the compendium build
// (structured) — never both. The bridge already carries handout text, so
// emitting prose here would create the exact duplication that rule forbids.
// This fills the gap the bridge leaves: every journal page the pipeline
// produced until now was type "text", which is why art could not be shared
// in-world at all.
//
// Usage:
//   node scripts/content/handout.mjs <note.md> [--vault <root>] [--out <journal.json>]
//     --vault  vault root, used to build Foundry's Data-relative path
//              (default $DND_VAULT_PATH)
//     --out    where the journal JSON lands (default: alongside the game's
//              Foundry/src/journals/)
//
// The compendium ships no images. `src` is a Data-relative path resolved at
// runtime through the vault mount at /data/Data/DnD, exactly like scene
// backgrounds — so one file serves the Obsidian embed and the Foundry page.
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import yaml from 'js-yaml';

const IMAGE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg']);

/** Foundry ownership levels. 2 = OBSERVER: players can open it themselves. */
export const OWNERSHIP = { GM_ONLY: 0, OBSERVER: 2 };

/** Read a note's YAML frontmatter. */
export function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  return yaml.load(m[1]) ?? {};
}

/**
 * Pull image embeds out of note markdown, in document order, de-duplicated.
 *
 * Handles Obsidian wikilink embeds (`![[art.webp]]`, with optional `|alias`)
 * and standard markdown images (`![alt](art.webp)`). Commented-out embeds are
 * ignored — the Handout template ships one as a hint, and picking that up would
 * make every scaffolded note claim art it does not have.
 */
export function parseEmbeds(markdown) {
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');
  const found = [];
  const push = (file, alias) => {
    const name = file.trim();
    if (!name || !IMAGE_EXTS.has(path.extname(name).toLowerCase())) return;
    if (found.some(e => e.file === name)) return;
    found.push({ file: name, caption: alias?.trim() || '' });
  };
  for (const m of withoutComments.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
    push(m[1], m[2]);
  }
  for (const m of withoutComments.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    push(decodeURIComponent(m[2]), m[1]);
  }
  return found;
}

/** A filename with no extension-bearing directory part is a bare Obsidian link. */
function isBareName(file) {
  return !file.includes('/');
}

/**
 * Resolve an embed to a path relative to the vault root.
 *
 * Obsidian wikilinks carry only a filename and resolve it anywhere in the
 * vault, so a bare name is searched for: the note's own game folder first
 * (nearest wins, which is what an author means), then the wider vault.
 */
export async function resolveAsset(file, { noteDir, gameDir, vaultRoot }) {
  const candidates = [];
  if (!isBareName(file)) {
    candidates.push(path.resolve(noteDir, file), path.resolve(vaultRoot, file));
  }
  for (const dir of [gameDir, vaultRoot]) {
    if (!dir) continue;
    const hit = await findByName(dir, path.basename(file));
    if (hit) {
      candidates.push(hit);
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.relative(vaultRoot, candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function findByName(root, name, depth = 6) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(root, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hit = await findByName(path.join(root, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Foundry resolves a page's `src` against its Data directory, and the vault is
 * mounted there as DnD/. Same convention scene backgrounds already use.
 */
export function dataRelative(vaultRelPath) {
  return path.posix.join('DnD', vaultRelPath.split(path.sep).join('/'));
}

/** One image page. `src` is top-level; the caption lives under `image`. */
export function imagePage(entry, ownership, sort) {
  return {
    name: entry.caption || path.parse(entry.file).name,
    type: 'image',
    src: entry.src,
    image: { caption: entry.caption || '' },
    title: { show: true, level: 1 },
    ownership: { default: ownership },
    sort,
  };
}

/**
 * Build the journal. Named "<Title> — Art" so it cannot collide with the prose
 * journal the Obsidian Bridge creates for the same note.
 */
export function handoutJournal(title, entries, { playerVisible = true } = {}) {
  const ownership = playerVisible ? OWNERSHIP.OBSERVER : OWNERSHIP.GM_ONLY;
  return {
    name: `${title} — Art`,
    ownership: { default: ownership },
    pages: entries.map((e, i) => imagePage(e, ownership, (i + 1) * 100)),
  };
}

export function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else opts.positional.push(a);
  }
  if (!opts.positional.length) throw new Error('Missing <note.md>');
  opts.note = opts.positional[0];
  opts.vault ??= process.env.DND_VAULT_PATH;
  return opts;
}

/**
 * A handout note lives at <game>/Handouts/<name>.md, so the game folder is its
 * parent's parent. Falls back to the note's own directory.
 */
export function gameDirFor(notePath) {
  const noteDir = path.dirname(path.resolve(notePath));
  return path.basename(noteDir).toLowerCase() === 'handouts' ? path.dirname(noteDir) : noteDir;
}

export async function compileHandout(notePath, opts = {}) {
  const vaultRoot = opts.vault;
  if (!vaultRoot) {
    throw new Error(
      'No vault root. Set DND_VAULT_PATH or pass --vault <path>: it is needed to ' +
        "build Foundry's Data-relative image paths.",
    );
  }
  const markdown = await readFile(notePath, 'utf8');
  const frontmatter = parseFrontmatter(markdown);
  const embeds = parseEmbeds(markdown);
  const title = path.basename(notePath, path.extname(notePath));

  const noteDir = path.dirname(path.resolve(notePath));
  const gameDir = gameDirFor(notePath);

  const resolved = [];
  const unresolved = [];
  for (const e of embeds) {
    const rel = await resolveAsset(e.file, { noteDir, gameDir, vaultRoot });
    if (rel) resolved.push({ ...e, src: dataRelative(rel) });
    else unresolved.push(e.file);
  }

  return {
    title,
    journal: handoutJournal(title, resolved, {
      playerVisible: frontmatter.player_visible !== false,
    }),
    resolved,
    unresolved,
    playerVisible: frontmatter.player_visible !== false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { title, journal, resolved, unresolved } = await compileHandout(opts.note, opts);

  if (unresolved.length) {
    // A missing image is a broken page at the table, not a warning to scroll
    // past: Foundry resolves src at runtime and shows an empty frame.
    throw new Error(
      `Could not find ${unresolved.length} embedded image(s) in the vault: ` +
        `${unresolved.join(', ')}.\nCheck the filename, or put the file under the game's Assets/.`,
    );
  }
  if (!resolved.length) {
    console.log(`${title}: no image embeds — nothing to build.`);
    return;
  }

  const out =
    opts.out ||
    path.join(gameDirFor(opts.note), 'Foundry', 'src', 'journals', `${slug(title)}-art.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(journal, null, 2)}\n`);
  console.log(`${out}: ${resolved.length} image page(s)`);
  for (const r of resolved) console.log(`  ${r.src}`);
}

/** build.mjs derives document ids from the filename, so it must be kebab-case. */
export function slug(name) {
  return name
    .toLowerCase()
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
