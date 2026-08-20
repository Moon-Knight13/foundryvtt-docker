#!/usr/bin/env node
// Prove a module's art coverage instead of promising it: walk the source tree,
// classify every art slot, and (with --strict) fail on any actor still wearing
// the placeholder or any Data-relative path that does not resolve to a file.
//
// The split rule this enforces is upstream, in art-resolve.mjs: mooks auto-fill
// from the curated map, bespoke named NPCs never do. So by the time documents
// reach this gate, a remaining placeholder means the chain came up empty for
// something someone authored — exactly the blank token #88 exists to prevent.
//
// Usage:
//   node scripts/content/art-coverage.mjs --config <path> [--src <path>]
//                                         [--vault <path>] [--strict]
//     --config  module config, as for build.mjs (REQUIRED — no default module)
//     --src     source root override, as for build.mjs
//     --vault   vault root for resolving DnD/ paths (default $DND_VAULT_PATH)
//     --strict  exit non-zero on failures — the warn-to-fail switch, same
//               doctrine as the statblock compiler's `exact: true`
//
// CI has no vault mount, so there DnD/ paths are counted `unchecked`, never
// verified — a green report in CI is a schema statement, not a coverage
// guarantee. Run with --vault (or $DND_VAULT_PATH) on the host for the proof.
import path from 'node:path';
import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS, loadConfig, resolveSrcRoot } from './build.mjs';
import { GENERIC_ART_DIR } from './art-resolve.mjs';
import { PLACEHOLDER_IMG } from './statblock.mjs';

/** One art slot's honest state. Core icons other than the placeholder are
 * deliberate choices (map pins use icons/svg/book.svg), so they count real. */
export function classifyArt(src) {
  if (!src) return 'missing';
  if (src === PLACEHOLDER_IMG) return 'placeholder';
  if (src.startsWith(`${GENERIC_ART_DIR}/`)) return 'generic';
  return 'real';
}

/** The art slots a document exposes, by collection. Items and tables are left
 * alone: their `img` is a core icon by design, not a coverage gap. */
function artSlots(collection, doc) {
  switch (collection) {
    case 'actors':
      return [
        { what: 'portrait', src: doc.img },
        { what: 'token', src: doc.prototypeToken?.texture?.src },
      ];
    case 'scenes':
      return [{ what: 'background', src: doc.background?.src }];
    case 'journals':
      return (doc.pages ?? [])
        .filter(p => p.type === 'image')
        .map(p => ({ what: `image page "${p.name}"`, src: p.src }));
    default:
      return [];
  }
}

/**
 * Walk a module source tree and classify every art slot.
 * With `vault`, DnD/ paths are resolved against it; without, they are counted
 * `unchecked` so the report cannot overstate what it verified.
 */
export async function audit(srcRoot, { vault } = {}) {
  const buckets = {
    real: 0,
    generic: 0,
    placeholder: 0,
    missing: 0,
    unchecked: 0,
    unresolvable: 0,
  };
  const failures = [];

  for (const collection of Object.keys(COLLECTIONS)) {
    const dir = path.join(srcRoot, collection);
    let files = [];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    } catch {
      continue; // No such collection in this module.
    }

    for (const file of files.sort()) {
      const relPath = `${collection}/${file}`;
      const doc = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      const problems = [];

      for (const { what, src } of artSlots(collection, doc)) {
        const kind = classifyArt(src);
        if (kind === 'real' || kind === 'generic') {
          if (src.startsWith('DnD/')) {
            if (vault) {
              try {
                await access(path.join(vault, src.slice('DnD/'.length)));
                buckets[kind]++;
              } catch {
                buckets.unresolvable++;
                problems.push(`${what} "${src}" does not exist in the vault`);
              }
            } else {
              buckets[kind]++;
              buckets.unchecked++;
            }
          } else {
            buckets[kind]++;
          }
        } else {
          buckets[kind]++;
          problems.push(
            `${what} is ${kind === 'missing' ? 'missing' : `the placeholder (${PLACEHOLDER_IMG})`}`,
          );
        }
      }

      if (problems.length) failures.push(`${relPath}: ${problems.join('; ')}`);
    }
  }

  return { buckets, failures };
}

/** One line per non-empty bucket, in describeArt's style. */
export function describeCoverage({ buckets, failures }) {
  const parts = [];
  if (buckets.real) parts.push(`  ${buckets.real} art slot(s) carry real art`);
  if (buckets.generic)
    parts.push(`  ${buckets.generic} use a generic silhouette from the curated map`);
  if (buckets.placeholder) parts.push(`  ${buckets.placeholder} still show the placeholder`);
  if (buckets.missing) parts.push(`  ${buckets.missing} have no art at all`);
  if (buckets.unresolvable)
    parts.push(`  ${buckets.unresolvable} reference vault files that do not exist`);
  if (buckets.unchecked) {
    parts.push(
      `  ${buckets.unchecked} are vault paths this run could not verify (no vault mounted)`,
    );
  }
  if (!failures.length) parts.push('  no blank tokens');
  return parts.join('\n');
}

function parseArgs(argv) {
  const opts = { vault: process.env.DND_VAULT_PATH, strict: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') opts.config = argv[++i];
    else if (argv[i] === '--src') opts.src = argv[++i];
    else if (argv[i] === '--vault') opts.vault = argv[++i];
    else if (argv[i] === '--strict') opts.strict = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadConfig(opts.config);
  const srcRoot = resolveSrcRoot(config, opts.src);
  const report = await audit(srcRoot, { vault: opts.vault });

  console.log(`Art coverage for ${config.id}:`);
  console.log(describeCoverage(report));
  for (const f of report.failures) console.warn(`  FAIL ${f}`);
  if (report.failures.length && opts.strict) {
    throw new Error(`${report.failures.length} document(s) would reach the table blank`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
