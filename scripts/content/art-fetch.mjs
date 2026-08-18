#!/usr/bin/env node
// Fetch the icons named by the curated art map (content/reference/art-map.json)
// into the vault, so mook tokens have a silhouette to resolve to.
//
// The icons land in the VAULT, not the repo — the repo is the pipeline, the
// vault is the content. Only the map and this script are committed; the SVGs
// are re-fetchable from the pinned commit at any time.
//
// Usage:
//   node scripts/content/art-fetch.mjs [--vault <path>] [--map <path>]
//     --vault  Obsidian vault root (default $DND_VAULT_PATH)
//     --map    curated art map (default content/reference/art-map.json)
//
// Icons are written to "<vault>/06 Assets/Tokens/generic/<artist>/<icon>.svg"
// — the artist directory is kept because CC-BY requires attribution, and an
// _attribution.md is written beside them naming every artist and the licence.
//
// Idempotent: a file that already exists is never re-fetched, so a re-run
// after adding one map entry downloads one file. raw.githubusercontent.com is
// on the devcontainer firewall allowlist; each fetch is pinned to the commit
// the map was curated against, never to a moving branch.
import path from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_MAP = path.join(REPO_ROOT, 'content', 'reference', 'art-map.json');

// Where the icons land, vault-relative. art-resolve.mjs's GENERIC_ART_DIR is
// this same place as Foundry sees it through the DnD/ mount.
export const VAULT_ART_DIR = '06 Assets/Tokens/generic';

/** Raw-content URL for one icon, pinned to the map's curated commit. */
export function rawUrl(source, icon) {
  const [repo, sha] = source.split('@');
  if (!sha) {
    throw new Error(
      `art map source "${source}" is not pinned to a commit — ` +
        'fetching a moving branch would silently change already-curated icons',
    );
  }
  return `https://raw.githubusercontent.com/${repo}/${sha}/${icon}`;
}

/** One line per artist plus the licence — the CC-BY paperwork for the folder. */
export function attribution(map) {
  const artists = [
    ...new Set(
      [...Object.values(map.byName ?? {}), ...Object.values(map.byType ?? {})].map(e => e.artist),
    ),
  ].sort();
  return [
    '# Icon attribution',
    '',
    `Icons from ${map.source} (https://game-icons.net), licence ${map.licence}`,
    `(${map.licenceUrl}). Fetched by scripts/content/art-fetch.mjs; do not edit by hand.`,
    '',
    ...artists.map(a => `- ${a}`),
    '',
  ].join('\n');
}

/**
 * Download every mapped icon into `destDir`, one artist directory each.
 * Existing files are skipped; individual failures are collected, not fatal.
 */
export async function fetchIcons(map, destDir, { fetchFn = fetch } = {}) {
  const stats = { fetched: 0, skipped: 0, failed: [] };
  const icons = new Map();
  for (const entry of [...Object.values(map.byName ?? {}), ...Object.values(map.byType ?? {})]) {
    icons.set(entry.icon, entry);
  }

  for (const icon of icons.keys()) {
    const dest = path.join(destDir, icon);
    try {
      await access(dest);
      stats.skipped++;
      continue;
    } catch {
      // Not there yet — fetch it.
    }
    try {
      const res = await fetchFn(rawUrl(map.source, icon));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      stats.fetched++;
    } catch (err) {
      stats.failed.push(`${icon}: ${err.message}`);
    }
  }

  await writeFile(path.join(destDir, '_attribution.md'), attribution(map));
  return stats;
}

function parseArgs(argv) {
  const opts = { vault: process.env.DND_VAULT_PATH, map: DEFAULT_MAP };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vault') opts.vault = argv[++i];
    else if (argv[i] === '--map') opts.map = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!opts.vault) {
    throw new Error('No vault: pass --vault or set DND_VAULT_PATH');
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const map = JSON.parse(await readFile(opts.map, 'utf8'));
  const destDir = path.join(opts.vault, VAULT_ART_DIR);
  const stats = await fetchIcons(map, destDir);
  console.log(`  fetched ${stats.fetched} icon(s) to ${destDir}`);
  if (stats.skipped) console.log(`  ${stats.skipped} already present, skipped`);
  if (stats.failed.length) {
    console.log(`  ${stats.failed.length} failed: ${stats.failed.slice(0, 3).join('; ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
