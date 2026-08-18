#!/usr/bin/env node
// Measure how much per-monster raster art www.dnd5eapi.co actually serves,
// before anyone builds on it. The SRD monster detail endpoint carries an
// optional `image` field; nobody publishes the hit rate, so this counts it.
//
// Run AFTER the devcontainer rebuild that activates the firewall allowlist
// entry — until then every request refuses to connect. Note the API redirects
// image bodies to S3 (a different host): this script probes one image and
// reports the final status, so a blocked redirect target is visible too.
//
// Usage:
//   node scripts/content/measure-dnd5eapi.mjs [--out <path>]
//     --out  also write the ready-to-paste raster block for art-map.json
//
// The emitted block ships with "enabled": false — measuring is not enabling;
// a human flips that after looking at the numbers.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const API = 'https://www.dnd5eapi.co';

/**
 * List every SRD monster, fetch each detail, and count the `image` fields.
 * Individual failures are collected, never fatal — a 500 on one monster must
 * not zero out the measurement.
 */
export async function measure({ fetchFn = fetch } = {}) {
  const listRes = await fetchFn(`${API}/api/2014/monsters`);
  if (!listRes.ok) throw new Error(`monster list: HTTP ${listRes.status}`);
  const { results } = await listRes.json();

  const hits = [];
  const errors = [];
  for (const { index } of results) {
    try {
      const res = await fetchFn(`${API}/api/2014/monsters/${index}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const monster = await res.json();
      if (monster.image) hits.push({ index, name: monster.name, image: monster.image });
    } catch (err) {
      errors.push(`${index}: ${err.message}`);
    }
  }
  return { total: results.length, withImage: hits.length, hits, errors };
}

/** The art-map.json `raster` fragment, disabled until a human enables it. */
export function rasterBlock(hits) {
  const byName = {};
  for (const h of hits) byName[h.name] = { src: `${API}${h.image}` };
  return { enabled: false, source: 'www.dnd5eapi.co SRD 2014 monsters', byName };
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx === -1 ? null : process.argv[outIdx + 1];

  const report = await measure();
  const pct = report.total ? Math.round((100 * report.withImage) / report.total) : 0;
  console.log(`  ${report.withImage} of ${report.total} SRD monsters carry an image (${pct}%)`);
  if (report.errors.length) {
    console.log(`  ${report.errors.length} detail fetch(es) failed, e.g. ${report.errors[0]}`);
  }

  // One real image GET, so a firewall-blocked S3 redirect shows up here and
  // not as a mystery at the table.
  if (report.hits.length) {
    const probeUrl = `${API}${report.hits[0].image}`;
    try {
      const res = await fetch(probeUrl);
      console.log(
        `  image probe ${probeUrl}: HTTP ${res.status}${res.url !== probeUrl ? ` via ${new URL(res.url).host}` : ''}`,
      );
      if (!res.ok)
        console.log('  → the redirect target likely needs its own firewall allowlist entry');
    } catch (err) {
      console.log(`  image probe failed (${err.message}) — allowlist the redirect host too`);
    }
  }

  if (out) {
    await writeFile(out, `${JSON.stringify(rasterBlock(report.hits), null, 2)}\n`);
    console.log(
      `  wrote raster block to ${out} — paste as "raster" into art-map.json when satisfied`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
