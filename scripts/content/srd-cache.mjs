#!/usr/bin/env node
// Build a slim, committed reference index of the dnd5e SRD monsters, used to
// (a) inherit token art and (b) verify authored stat blocks against the base
// creature they were written from.
//
// Run this on the HOST, not inside the devcontainer: it reads the Foundry data
// directory, which the devcontainer does not mount. No network access, and no
// running Foundry server — it reads the compendium LevelDB directly.
//
// Usage:
//   node scripts/content/srd-cache.mjs [--data <path>] [--out <dir>] [--art <dir>]
//     --data  Foundry data dir (default $FOUNDRY_DATA_PATH, else ~/.local/share/FoundryVTT)
//     --out   where the JSON indexes land (default content/reference/)
//     --art   also copy each creature's token art here (e.g. the vault's
//             "06 Assets/Tokens/srd"), so Obsidian can render it on the printed
//             statblock card — a systems/dnd5e/... path means nothing outside
//             Foundry.
//
// The SRD content this reads is CC-BY-4.0; see content/reference/LICENSE.
import path from 'node:path';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  access,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { isLockError, explainLevelError } from './leveldb.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

// Which system packs to distil, and the edition each one carries. The vault's
// statblock notes cite their source ("SRD 5.1 … — Lamia"), so both are indexed
// and the note decides which edition it is checked against.
export const PACKS = [
  { pack: 'monsters', edition: '5.1', out: 'srd-51.json' },
  { pack: 'actors24', edition: '5.2', out: 'srd-52.json' },
];

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// Movement and senses are stored as strings on some documents and numbers on
// others; normalise so a diff never trips on "30" !== 30.
function num(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reduce a raw SRD actor document to the fields worth comparing against.
 *
 * NOTE: extractPack yields the document as STORED, not as Foundry derives it at
 * runtime. Armour-wearing monsters therefore carry no numeric AC here — Bandit
 * stores {calc:"default", flat:null} and its 12 is computed from equipped
 * Leather Armor plus a Dex modifier. Rather than re-implement the system's AC
 * pipeline (which would drift with every dnd5e release), the calc mode is
 * recorded and `ac` is left undefined when it cannot be read directly. A
 * consumer must treat a missing `ac` as "not checkable", never as "AC 0".
 */
export function distill(doc) {
  const sys = doc.system ?? {};
  const attrs = sys.attributes ?? {};
  const ac = attrs.ac ?? {};

  const abilities = {};
  for (const k of ABILITIES) abilities[k] = num(sys.abilities?.[k]?.value);

  const speed = {};
  for (const [k, v] of Object.entries(attrs.movement ?? {})) {
    const n = num(v);
    if (n !== undefined && n > 0) speed[k] = n;
  }

  const senses = {};
  for (const [k, v] of Object.entries(attrs.senses?.ranges ?? {})) {
    const n = num(v);
    if (n !== undefined && n > 0) senses[k] = n;
  }

  return {
    name: doc.name,
    img: doc.img,
    tokenSrc: doc.prototypeToken?.texture?.src ?? doc.img,
    ac: num(ac.flat),
    acCalc: ac.calc ?? 'flat',
    hp: num(attrs.hp?.max),
    hpFormula: attrs.hp?.formula || undefined,
    cr: num(sys.details?.cr),
    size: sys.traits?.size,
    type: sys.details?.type?.value,
    abilities,
    speed,
    senses,
    languages: sys.traits?.languages?.value ?? [],
  };
}

/** Index distilled records by creature name, dropping anything unnamed. */
export function srdIndex(docs) {
  const out = {};
  for (const doc of docs) {
    if (!doc?.name) continue;
    out[doc.name] = distill(doc);
  }
  // Sorted so the committed file has a stable diff.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') opts.data = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--art') opts.art = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  opts.data ??=
    process.env.FOUNDRY_DATA_PATH ||
    path.join(process.env.HOME ?? '', '.local', 'share', 'FoundryVTT');
  opts.out ??= path.join(REPO_ROOT, 'content', 'reference');
  return opts;
}

/** Read every extracted .json in a directory back into memory. */
async function readDocs(dir) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  return Promise.all(files.map(async f => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}

/**
 * Copy each creature's token art out of the Foundry install into `artDir`, so
 * one file serves both the Obsidian card and the Foundry token. Returns the
 * number copied. Missing art is skipped, not fatal — some entries ship none.
 */
export async function copyArt(index, dataDir, artDir) {
  await mkdir(artDir, { recursive: true });
  let copied = 0;
  for (const rec of Object.values(index)) {
    const src = rec.tokenSrc;
    if (!src || src.startsWith('icons/')) continue; // core placeholder, not real art
    try {
      await copyFile(
        path.join(dataDir, 'Data', src),
        path.join(artDir, `${rec.name}${path.extname(src)}`),
      );
      copied++;
    } catch {
      // no shipped art for this creature — expected for some entries
    }
  }
  return copied;
}

/**
 * Fail early and say why. Run inside the devcontainer this finds nothing, and
 * without this check the only symptom is "Skipping monsters:" twice — which
 * reads like a missing dnd5e system rather than the real cause: the Foundry
 * data directory is deliberately not mounted there.
 */
export async function assertDataDir(data) {
  const systemPacks = path.join(data, 'Data', 'systems', 'dnd5e', 'packs');
  try {
    await access(systemPacks);
  } catch {
    const inContainer = existsSync('/.dockerenv');
    throw new Error(
      `No dnd5e packs at ${systemPacks}.\n` +
        (inContainer
          ? '\nThis looks like a container. The Foundry data directory is not mounted\n' +
            'into the devcontainer by design — run this on the HOST instead.\n'
          : '') +
        `\nChecked FOUNDRY_DATA_PATH${process.env.FOUNDRY_DATA_PATH ? '' : ' (unset)'}` +
        `, resolved data dir: ${data}\n` +
        'Pass an explicit one with --data <path> if it lives elsewhere.',
    );
  }
  return systemPacks;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const systemPacks = await assertDataDir(opts.data);
  await mkdir(opts.out, { recursive: true });
  const failed = [];

  for (const { pack, edition, out } of PACKS) {
    const packDir = path.join(systemPacks, pack);
    // extractPack on a missing path creates an empty database and dies with a
    // misleading "Iterator is not open", so check before blaming a lock.
    const packExists = existsSync(packDir);
    const tmp = await mkdtemp(path.join(tmpdir(), `srd-${pack}-`));
    try {
      if (!packExists) throw new Error(`no such pack directory: ${packDir}`);
      await extractPack(packDir, tmp, { log: false });
      const creatures = srdIndex(await readDocs(tmp));
      const dest = path.join(opts.out, out);
      await writeFile(
        dest,
        `${JSON.stringify({ edition, source: `dnd5e/${pack}`, creatures }, null, 2)}\n`,
      );
      console.log(`${dest}: ${Object.keys(creatures).length} creatures (SRD ${edition})`);
      if (opts.art) {
        console.log(
          `  copied ${await copyArt(creatures, opts.data, opts.art)} token images to ${opts.art}`,
        );
      }
    } catch (err) {
      // A locked database is not a pack to skip past — it means Foundry is
      // running, and every pack will fail the same way. Say so once and stop,
      // rather than printing two shrugs and exiting 0 with no cache written.
      if (isLockError(err, { pathExists: packExists })) {
        throw new Error(explainLevelError(err, `the ${pack} pack`, { pathExists: packExists }));
      }
      console.error(`Skipping ${pack}: ${err.message}`);
      failed.push(pack);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  if (failed.length === PACKS.length) {
    throw new Error(`No pack could be read (${failed.join(', ')}). Nothing was written.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
