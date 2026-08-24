#!/usr/bin/env node
// Give an SVG an intrinsic size, so a renderer never has to guess one.
//
// PIXI reads a texture's natural dimensions from the `width`/`height`
// attributes on the `<svg>` tag. A file carrying only a `viewBox` has no
// intrinsic size, so the browser falls back to the CSS default box for a
// replaced element (300x150) and letterboxes the drawing into the middle of it,
// padding the rest with transparency. Foundry then fits that padded bitmap into
// the token frame with `texture.fit: "contain"`, and the art lands at roughly
// half the size of the square it belongs in — at every token size, which is
// what makes it read as "the token is too small" rather than "the art is
// padded".
//
// game-icons.net ships its downloads viewBox-only, and hand-authored token art
// copies that shape, so this is not a one-off: anything we write into the
// vault's Tokens/ tree gets stamped.

const SVG_OPEN = /<svg\b[^>]*>/i;
const HAS_WIDTH = /<svg\b[^>]*\bwidth\s*=/i;
const VIEWBOX = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i;

/** Does this SVG declare the intrinsic size a rasterizer needs? */
export function hasIntrinsicSize(text) {
  const tag = SVG_OPEN.exec(text)?.[0];
  return Boolean(tag && HAS_WIDTH.test(tag));
}

/** Trim a viewBox number for use as an attribute: "512.0" -> "512". */
function trim(n) {
  return n.endsWith('.0') ? n.slice(0, -2) : n;
}

/**
 * Stamp `width`/`height` onto an SVG from its own viewBox.
 *
 * Returns the original text unchanged when there is nothing to do — already
 * sized, no `<svg>` tag, or no viewBox to take the numbers from. Idempotent, so
 * it is safe to run over a whole tree repeatedly.
 */
export function stampSvgSize(text) {
  const m = SVG_OPEN.exec(text);
  if (!m || hasIntrinsicSize(text)) return text;
  const vb = VIEWBOX.exec(m[0]);
  if (!vb) return text;
  const tag = `${m[0].slice(0, 4)} width="${trim(vb[1])}" height="${trim(vb[2])}"${m[0].slice(4)}`;
  return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
}

/**
 * Stamp every SVG under `root`. Returns what changed, without writing unless
 * `apply` is set — the same dry-run-first shape as the other vault tools.
 */
export async function stampTree(root, { apply = false, fs } = {}) {
  const { readdir, readFile, writeFile } = fs ?? (await import('node:fs/promises'));
  const { join } = await import('node:path');
  const stamped = [];
  let alreadySized = 0;

  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.toLowerCase().endsWith('.svg')) {
        const text = await readFile(full, 'utf8');
        const out = stampSvgSize(text);
        if (out === text) alreadySized++;
        else {
          stamped.push(full);
          if (apply) await writeFile(full, out, 'utf8');
        }
      }
    }
  };
  await walk(root);
  return { stamped, alreadySized };
}

if (process.argv[1] && process.argv[1].endsWith('svg-size.mjs')) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const root = args.find(a => !a.startsWith('--'));
  if (!root) {
    console.error('Usage: svg-size.mjs <dir> [--apply]');
    process.exit(1);
  }
  const { stamped, alreadySized } = await stampTree(root, { apply });
  console.log(apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)');
  console.log(`  already sized : ${alreadySized}`);
  console.log(`  ${apply ? 'stamped' : 'would stamp'} : ${stamped.length}`);
  for (const f of stamped.slice(0, 20)) console.log(`    ${f}`);
  if (stamped.length > 20) console.log(`    ... and ${stamped.length - 20} more`);
}
